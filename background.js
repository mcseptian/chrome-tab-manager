// Listen for tab URL updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only process when the URL changes and it's a valid web page
  if (changeInfo.url && !changeInfo.url.startsWith("chrome://")) {
    await processTab(tab);
  }
});

// This adds a small number badge to the icon
chrome.tabGroups.query({}, (groups) => {
  chrome.action.setBadgeText({ text: groups.length.toString() });
  chrome.action.setBadgeBackgroundColor({ color: "#282828" });
});

async function processTab(tab) {
  if (
    !tab.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("about:")
  )
    return;

  try {
    // 0. Check for duplicates across all windows
    const allTabsInAllWindows = await chrome.tabs.query({});
    const duplicate = allTabsInAllWindows.find(
      (t) => t.id !== tab.id && t.url === tab.url,
    );

    if (duplicate) {
      // Focus the existing tab and its window
      await chrome.tabs.update(duplicate.id, { active: true });
      await chrome.windows.update(duplicate.windowId, { focused: true });
      // Remove the new duplicate tab
      await chrome.tabs.remove(tab.id);
      return;
    }

    const { customRules = [] } = await chrome.storage.sync.get("customRules");
    let groupTitle = getDomain(tab.url); // Default to domain (e.g., "Youtube")
    let isCustom = false;

    // 1. Check Custom Rules
    for (const rule of customRules) {
      try {
        const regex = new RegExp(rule.regex);
        if (regex.test(tab.url)) {
          groupTitle = rule.name; // Change title to your Custom Name (e.g., "Local")
          isCustom = true;
          break;
        }
      } catch (e) {
        console.error("[Tab Manager] Regex Error:", e);
      }
    }

    // 2. Get ALL tabs in the window to see who else belongs in this group
    const allTabs = await chrome.tabs.query({ windowId: tab.windowId });
    const matchingTabs = allTabs.filter((t) => {
      // A tab matches if:
      // It matches the same custom rule OR it shares the same raw domain
      const tabDomain = getDomain(t.url);
      if (isCustom) {
        // If we are in a custom rule, we check if this other tab also fits the regex
        for (const rule of customRules) {
          if (rule.name === groupTitle) {
            return new RegExp(rule.regex).test(t.url);
          }
        }
      }
      return getDomain(t.url) === getDomain(tab.url);
    });

    // 3. Trigger Grouping
    if (matchingTabs.length >= 2 || isCustom) {
      // Find existing group by TITLE
      const existingGroups = await chrome.tabGroups.query({
        windowId: tab.windowId,
        title: groupTitle,
      });
      let targetGroupId =
        existingGroups.length > 0 ? existingGroups[0].id : undefined;

      // Verify the group ID is actually valid before using it
      if (targetGroupId) {
        try {
          await chrome.tabGroups.get(targetGroupId);
        } catch (e) {
          // Group doesn't exist anymore! Reset to undefined to create a new one.
          targetGroupId = undefined;
          console.error("[Tab Manager] Find Group Error:", e);
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
          const groupId = await chrome.tabs.group({
            tabIds: cleanIds,
            groupId: targetGroupId, // If this was undefined, a new group is born
          });
          await chrome.tabGroups.update(groupId, { title: groupTitle });
        } catch (groupErr) {
          // Final fallback: just group without a specific ID if everything else fails
          const groupId = await chrome.tabs.group({ tabIds: cleanIds });
          await chrome.tabGroups.update(groupId, { title: groupTitle });
          console.error("[Tab Manager] New Group Error:", groupErr);
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
          otherId = undefined;
          console.error("[Tab Manager] Other Group Error:", e);
        }
      }

      // Check if it's new to the "Other" group to decide on positioning
      const isNewToOther = tab.groupId !== otherId;
      const otherTabs = otherId
        ? await chrome.tabs.query({ groupId: otherId })
        : [];

      const gId = await chrome.tabs.group({ tabIds: tab.id, groupId: otherId });
      await chrome.tabGroups.update(gId, { title: "Other", color: "grey" });

      // If it just joined "Other", move it to the front of that group
      if (isNewToOther && otherTabs.length > 0) {
        const startIndex = Math.min(...otherTabs.map((t) => t.index));
        await chrome.tabs.move(tab.id, { index: startIndex });
      }
    }
  } catch (err) {
    if (err.message.includes("Tabs cannot be edited")) {
      setTimeout(() => processTab(tab), 1000);
    }
  }
}

async function orderTabsInGroup(groupId, tabsToSort, activeTabId, isNew) {
  // Use the tabs directly since duplicates are now handled at the start of processTab
  const uniqueTabs = [...tabsToSort];

  // Sort based on current index to maintain order
  uniqueTabs.sort((a, b) => a.index - b.index);

  // If it's a new tab for this group, move it to the first position
  if (isNew && activeTabId) {
    const activeIndex = uniqueTabs.findIndex((t) => t.id === activeTabId);
    if (activeIndex > -1) {
      const [activeTab] = uniqueTabs.splice(activeIndex, 1);
      uniqueTabs.unshift(activeTab);
    }
  }

  const cleanIds = uniqueTabs.map((t) => t.id);

  // If already in a group, move them to the sorted order
  if (groupId && cleanIds.length > 0) {
    const startIndex = Math.min(...tabsToSort.map((t) => t.index));
    await chrome.tabs.move(cleanIds, { index: startIndex }).catch((e) => {
      console.error("[Tab Manager] Move Tab Error:", e);
    });
  }

  return cleanIds; // Return this to processTab
}

// Helper function to scan all groups for a matching domain
async function findGroupWithSameDomain(newTab, targetName) {
  // First, check if a group exists with the exact name (fastest)
  const groupsByName = await chrome.tabGroups.query({
    windowId: newTab.windowId,
    title: targetName,
  });
  if (groupsByName.length > 0) return groupsByName[0].id;

  // Second, scan all groups to see if they contain a tab from the same domain
  const allGroups = await chrome.tabGroups.query({ windowId: newTab.windowId });

  for (const group of allGroups) {
    const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
    for (const t of tabsInGroup) {
      if (getDomain(t.url) === targetName) {
        return group.id; // Found a match in a group (like "Other")
      }
    }
  }

  return undefined; // No match found anywhere
}

// --- THIS IS THE UPDATED FUNCTION ---
function getDomain(urlString) {
  try {
    const url = new URL(urlString);

    // 1. Get the hostname (e.g., "www.github.com" or "gist.github.com")
    let host = url.hostname;

    // 2. Remove "www." if it exists
    host = host.replace(/^www\./, "");

    // 3. Remove the top-level domain (.com, .org, etc.)
    // This turns "github.com" into "github"
    let namePart = host.includes(".")
      ? host.substring(0, host.lastIndexOf("."))
      : host;

    // 4. Handle subdomains (e.g., "gist.github" -> "github")
    // We take the last word before the extension
    if (namePart.includes(".")) {
      const parts = namePart.split(".");
      namePart = parts[parts.length - 1];
    }

    // 5. Capitalize the first letter ("github" -> "Github")
    return namePart.charAt(0).toUpperCase() + namePart.slice(1);
  } catch {
    return "Other";
  }
}
