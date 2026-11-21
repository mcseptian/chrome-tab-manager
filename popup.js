document.addEventListener("DOMContentLoaded", () => {
  loadGroups();
  loadRules();
});
document.getElementById("addRule").addEventListener("click", addRule);
document.getElementById("generateRegex").addEventListener("click", generateRegex);

async function loadGroups() {
  const groupList = document.getElementById("groupList");
  groupList.innerHTML = "";

  try {
    const groups = await chrome.tabGroups.query({});

    if (groups.length === 0) {
      groupList.innerHTML =
        '<p class="no-active-groups-message">No active groups</p>';
      return;
    }

    // Sort groups by title
    groups.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    for (const group of groups) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const div = document.createElement("div");
      div.className = "group-item";

      div.className = `group-item group-color-${group.color || "grey"}`;

      div.innerHTML = `
        <div class="group-info">
          <strong>${group.title || "Untitled"}</strong>
          <span class="tab-count">${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}</span>
        </div>
      `;

      // Click to go to the group
      div.addEventListener("click", async () => {
        if (tabs.length > 0) {
          // Focus the first tab in the group
          await chrome.tabs.update(tabs[0].id, { active: true });
          // Focus the window containing that tab
          await chrome.windows.update(tabs[0].windowId, { focused: true });
          // Close popup after selection
          window.close();
        }
      });

      groupList.appendChild(div);
    }
  } catch (err) {
    console.error("Error loading groups:", err);
    groupList.innerHTML = "<p>Error loading groups</p>";
  }
}

async function loadRules() {
  const { customRules = [] } = await chrome.storage.sync.get("customRules");
  const list = document.getElementById("ruleList");
  list.innerHTML = "";

  customRules.forEach((rule, index) => {
    const div = document.createElement("div");
    div.className = "rule-item";
    div.innerHTML = `
            <div class="rule-name">
              <strong class="rule-title">${rule.name}</strong>
              <span class="rule-regex">(${rule.regex})</span>
            </div>
            <button class="delete-btn" data-index="${index}">x</button>
        `;
    list.appendChild(div);
  });

  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", deleteRule);
  });
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generateRegex() {
  const input = document.getElementById("domainInput").value;
  const domains = input
    .split(/[,;\n]+/)
    .map((d) => d.trim())
    .filter(Boolean);

  if (domains.length === 0) {
    alert("Please enter at least one domain");
    return;
  }

  const parts = domains.map((domain) => {
    // Allow optional subdomains for multi-part domains (e.g. sbonline-dev.ph).
    if (domain.includes(".")) {
      const escaped = escapeRegex(domain);
      return `(?:[a-zA-Z0-9-]+\\.)*${escaped}`;
    }
    return escapeRegex(domain);
  });

  const regex = `^(${parts.join("|")})$`;
  document.getElementById("regexInput").value = regex;
}

async function addRule() {
  const regex = document.getElementById("regexInput").value.trim();
  const name = document.getElementById("nameInput").value.trim();

  if (!regex || !name) return alert("Please fill both fields");

  // Validate Regex before saving
  try {
    new RegExp(regex);
  } catch (e) {
    console.error("Invalid Regex pattern:", e);
    return alert("Invalid Regex pattern");
  }

  const { customRules = [] } = await chrome.storage.sync.get("customRules");
  customRules.push({ regex, name });
  await chrome.storage.sync.set({ customRules });

  document.getElementById("regexInput").value = "";
  document.getElementById("nameInput").value = "";
  loadRules();
}

async function deleteRule(e) {
  const index = e.target.getAttribute("data-index");
  const { customRules = [] } = await chrome.storage.sync.get("customRules");

  customRules.splice(index, 1);
  await chrome.storage.sync.set({ customRules });

  loadRules();
}
