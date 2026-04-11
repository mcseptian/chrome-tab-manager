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
  chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" }); // Green background
});

async function processTab(tab) {
  // 1. Skip internal chrome pages
  if (!tab.url || tab.url.startsWith("chrome://")) return;

  const { customRules = [] } = await chrome.storage.sync.get("customRules");
  let domainName = getDomain(tab.url);
  let isCustom = false;

  // 2. Regex Check
  for (const rule of customRules) {
    try {
      const regex = new RegExp(rule.regex);
      if (regex.test(tab.url)) {
        domainName = rule.name;
        isCustom = true;
        break;
      }
    } catch (e) {
      console.error("Regex Error:", e);
    }
  }

  // 3. Count matching tabs
  const allTabs = await chrome.tabs.query({ windowId: tab.windowId });
  const matchingTabs = allTabs.filter((t) => getDomain(t.url) === domainName);

  // 4. Decision Logic
  if (matchingTabs.length >= 2 || isCustom) {
    const groups = await chrome.tabGroups.query({
      windowId: tab.windowId,
      title: domainName,
    });
    let targetGroupId = groups.length > 0 ? groups[0].id : undefined;

    // CRITICAL FIX: Run the order/deduplicate function FIRST
    // to get the clean list of surviving IDs
    const cleanTabIds = await orderTabsInGroup(
      targetGroupId,
      matchingTabs,
      domainName,
    );

    if (cleanTabIds.length > 0) {
      const groupId = await chrome.tabs.group({
        tabIds: cleanTabIds,
        groupId: targetGroupId,
      });

      if (!targetGroupId) {
        await chrome.tabGroups.update(groupId, { title: domainName });
      }
    }
  } else if (matchingTabs.length === 1) {
    const otherGroups = await chrome.tabGroups.query({
      windowId: tab.windowId,
      title: "Other",
    });
    let otherGroupId = otherGroups.length > 0 ? otherGroups[0].id : undefined;

    try {
      const groupId = await chrome.tabs.group({
        tabIds: tab.id,
        groupId: otherGroupId,
      });
      if (!otherGroupId) {
        await chrome.tabGroups.update(groupId, {
          title: "Other",
          color: "grey",
        });
      }
    } catch (e) {
      console.log("Tab already grouped or closed");
    }
  }
}

async function orderTabsInGroup(groupId, tabsToSort, groupName) {
  const seenUrls = new Set();
  const uniqueTabs = [];

  // Reverse to keep NEWER tabs (as discussed before)
  const tabsToProcess = [...tabsToSort].reverse();

  for (const t of tabsToProcess) {
    if (seenUrls.has(t.url)) {
      await chrome.tabs.remove(t.id).catch(() => {}); // Catch if already closed
    } else {
      seenUrls.add(t.url);
      uniqueTabs.push(t);
    }
  }

  // Sort descending
  uniqueTabs.sort((a, b) => {
    const valA = (a.title || a.url).toLowerCase();
    const valB = (b.title || b.url).toLowerCase();
    return valA < valB ? 1 : -1;
  });

  const cleanIds = uniqueTabs.map((t) => t.id);

  // If already in a group, move them to the sorted order
  if (groupId && cleanIds.length > 0) {
    const startIndex = Math.min(...uniqueTabs.map((t) => t.index));
    await chrome.tabs.move(cleanIds, { index: startIndex }).catch(() => {});
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
  } catch (e) {
    return "Other";
  }
}
