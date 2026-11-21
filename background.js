// Set to true to enable debug logging
const DEBUG = false;
function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

// Listen for tab URL updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only process when the URL changes and it's a valid web page
  if (changeInfo.url && !changeInfo.url.startsWith("chrome://")) {
    await processTab(tab);
  }
});

// Also process newly created tabs and activated tabs, which helps custom rules trigger
chrome.tabs.onCreated.addListener((tab) => {
  setTimeout(() => processTab(tab), 1000);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await processTab(tab);
  } catch (e) {
    console.error("[Tab Manager] onActivated Error:", e);
  }
});

// This adds a small number badge to the icon
chrome.tabGroups.query({}, (groups) => {
  chrome.action.setBadgeText({ text: groups.length.toString() });
  chrome.action.setBadgeBackgroundColor({ color: "#282828" });
});

async function processTab(tab) {
  debugLog("[Tab Manager] processTab called:", tab && tab.url);
  if (
    !tab.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("about:")
  )
    return;

  try {
    // 0. Check for duplicates across all windows
    // Normalize URLs by removing the hash and any trailing slash so that
    // "https://example.com/page" and "https://example.com/page/#section"
    // are treated as the same tab.
    const allTabsInAllWindows = await chrome.tabs.query({});
    const normalizedCurrent = normalizeUrlForDuplicate(tab.url);
    const duplicate = allTabsInAllWindows.find(
      (t) => t.id !== tab.id && normalizeUrlForDuplicate(t.url) === normalizedCurrent,
    );

    if (duplicate) {
      debugLog("[Tab Manager] Duplicate tab found:", tab.url, "existing tab:", duplicate.id);
      try {
        await chrome.tabs.update(duplicate.id, { active: true });
        await chrome.windows.update(duplicate.windowId, { focused: true });
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        console.error("[Tab Manager] Duplicate Removal Error:", e);
      }
      return;
    }

    const { customRules = [] } = await chrome.storage.sync.get("customRules");
    debugLog("[Tab Manager] processTab:", tab.url, "rules:", customRules.length);
    let groupTitle = getDomain(tab.url);
    let isCustom = false;

    // 1. Check Custom Rules
    // Custom rules are matched against the tab's hostname/host (not the full URL),
    // so anchored patterns like "^(localhost|...)$" work as expected.
    // We also fall back to testing the full URL for backward compatibility.
    for (const rule of customRules) {
      try {
        if (ruleMatches(rule, tab.url)) {
          debugLog("[Tab Manager] Custom rule matched:", rule.name, "for", tab.url);
          groupTitle = rule.name;
          isCustom = true;
          break;
        }
      } catch (e) {
        console.error("[Tab Manager] Regex Error:", e);
      }
    }

    // 2. Get ALL tabs in the window
    const allTabs = await chrome.tabs.query({ windowId: tab.windowId });
    const matchingTabs = allTabs.filter((t) => {
      if (isCustom) {
        const rule = customRules.find(r => r.name === groupTitle);
        if (!rule) return false;
        return ruleMatches(rule, t.url);
      }
      return getDomain(t.url) === getDomain(tab.url);
    });

    // 3. Trigger Grouping
    if (matchingTabs.length >= 2 || isCustom) {
      const existingGroups = await chrome.tabGroups.query({
        windowId: tab.windowId,
        title: groupTitle,
      });

      let targetGroupId = existingGroups.length > 0 ? existingGroups[0].id : undefined;

      if (targetGroupId) {
        try {
          await chrome.tabGroups.get(targetGroupId);
        } catch (e) {
          console.error("[Tab Manager] Target Group Error:", e);
          targetGroupId = undefined;
        }
      }

      const isNewToGroup = tab.groupId !== targetGroupId;
      const cleanIds = await orderTabsInGroup(
        targetGroupId,
        matchingTabs,
        tab.id,
        isNewToGroup,
      );

      if (cleanIds.length > 0) {
        try {
          // Re-verify tabs still exist before grouping to prevent "No tab with id" errors
          const currentTabs = await chrome.tabs.query({ windowId: tab.windowId });
          const currentIds = new Set(currentTabs.map(t => t.id));
          const verifiedIds = cleanIds.filter(id => currentIds.has(id));

          if (verifiedIds.length > 0) {
            let groupId;
            if (targetGroupId) {
              groupId = await chrome.tabs.group({
                tabIds: verifiedIds,
                groupId: targetGroupId,
              });
            } else {
              groupId = await chrome.tabs.group({ tabIds: verifiedIds });
            }
            await chrome.tabGroups.update(groupId, { title: groupTitle });
            debugLog("[Tab Manager] Grouped tabs into:", groupTitle, "groupId:", groupId);
          }
        } catch (groupErr) {
          console.error("[Tab Manager] Group Error:", groupErr);
          // If tabs are being dragged, catch and retry via the outer catch
          if (groupErr.message.includes("Tabs cannot be edited")) {
            throw groupErr;
          }

          // Final fallback: try creating a new group if the targetGroupId was the problem
          try {
            const groupId = await chrome.tabs.group({ tabIds: cleanIds.filter(id => id !== undefined) });
            await chrome.tabGroups.update(groupId, { title: groupTitle });
            debugLog("[Tab Manager] Grouped tabs (fallback) into:", groupTitle);
          } catch (retryErr) {
            console.error("[Tab Manager] Grouping Fallback Failed:", retryErr.message);
          }
        }
      }
    } else {
      // Move to "Other"
      const otherGroups = await chrome.tabGroups.query({
        windowId: tab.windowId,
        title: "Other",
      });
      let otherId = otherGroups.length > 0 ? otherGroups[0].id : undefined;

      if (otherId) {
        try {
          await chrome.tabGroups.get(otherId);
        } catch (e) {
          console.error("[Tab Manager] Other Group Lookup Error:", e);
          otherId = undefined;
        }
      }

      const isNewToOther = tab.groupId !== otherId;
      const otherTabs = otherId ? await chrome.tabs.query({ groupId: otherId }) : [];

      try {
        const gId = await chrome.tabs.group({ tabIds: tab.id, groupId: otherId });
        await chrome.tabGroups.update(gId, { title: "Other", color: "grey" });

        if (isNewToOther && otherTabs.length > 0) {
          const startIndex = Math.min(...otherTabs.map((t) => t.index));
          await chrome.tabs.move(tab.id, { index: startIndex });
        }
      } catch (e) {
        console.error("[Tab Manager] Other Group Error:", e.message);
      }
    }
  } catch (err) {
    if (err.message.includes("Tabs cannot be edited")) {
      // Retry after a delay if the user was dragging tabs
      setTimeout(() => processTab(tab), 1000);
    } else {
      console.error("[Tab Manager] Process Error:", err.message);
    }
  }
}

async function orderTabsInGroup(groupId, tabsToSort, activeTabId, isNew) {
  const uniqueTabs = [...tabsToSort];
  uniqueTabs.sort((a, b) => a.index - b.index);

  if (isNew && activeTabId) {
    const activeIndex = uniqueTabs.findIndex((t) => t.id === activeTabId);
    if (activeIndex > -1) {
      const [activeTab] = uniqueTabs.splice(activeIndex, 1);
      uniqueTabs.unshift(activeTab);
    }
  }

  const cleanIds = uniqueTabs.map((t) => t.id);

  // Only move if we aren't about to call chrome.tabs.group,
  // because chrome.tabs.group moves tabs automatically.
  if (groupId && cleanIds.length > 0) {
    try {
      const startIndex = Math.min(...tabsToSort.map((t) => t.index));
      await chrome.tabs.move(cleanIds, { index: startIndex });
    } catch (e) {
      console.error("[Tab Manager] Order Tabs Move Error:", e);
      // Ignore move errors as grouping will likely fix the position anyway
    }
  }

  return cleanIds;
}

function normalizeUrlForDuplicate(urlString) {
  try {
    const url = new URL(urlString);
    // Drop the hash
    url.hash = "";
    // Remove a trailing slash from the pathname (but keep "/" for the root)
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.href;
  } catch {
    // Fall back to the raw string if the URL can't be parsed
    return (urlString || "").split("#")[0].replace(/\/+$/, "");
  }
}

function getHostname(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch (e) {
    console.error("[Tab Manager] getHostname Error:", e);
    return "";
  }
}

function getHost(urlString) {
  try {
    return new URL(urlString).host;
  } catch (e) {
    console.error("[Tab Manager] getHost Error:", e);
    return "";
  }
}

function ruleMatches(rule, urlString) {
  const regex = new RegExp((rule.regex || "").trim());
  const candidates = [getHostname(urlString), getHost(urlString), urlString];
  debugLog("[Tab Manager] ruleMatches regex:", JSON.stringify(rule.regex));
  debugLog("[Tab Manager] candidates:", candidates);
  const result = candidates.some((candidate) => {
    regex.lastIndex = 0;
    const matched = regex.test(candidate);
    debugLog("[Tab Manager] testing", JSON.stringify(candidate), "->", matched);
    return matched;
  });
  debugLog("[Tab Manager] ruleMatches result:", result);
  return result;
}

function getDomain(urlString) {
  try {
    const url = new URL(urlString);
    let host = url.hostname.replace(/^www\./, "");
    let namePart = host.includes(".") ? host.substring(0, host.lastIndexOf(".")) : host;

    if (namePart.includes(".")) {
      const parts = namePart.split(".");
      namePart = parts[parts.length - 1];
    }

    return namePart.charAt(0).toUpperCase() + namePart.slice(1);
  } catch (e) {
    console.error("[Tab Manager] getDomain Error:", e);
    return "Other";
  }
}
