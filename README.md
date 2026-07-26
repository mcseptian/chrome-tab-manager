# chrome-tab-manager

Auto group tabs by domain, sort them ascending, prevent duplicate and use custom Regex rules.

## Features

- **Automatic Tab Grouping**: Automatically organizes your tabs into groups based on their domain. For example, all tabs from `youtube.com` will be grouped under "Youtube".
- **Custom Grouping Rules**: Define your own regular expression (regex) rules to group tabs that don't fit the default domain-based grouping. Assign a custom name to these groups (e.g., "Local Development" for `localhost` URLs).
- **Duplicate Tab Prevention**: When you open a URL that is already open in another tab (even across different windows), the extension will automatically switch you to the existing tab and close the newly opened duplicate.

* **Intelligent Tab Ordering**: Within each group, tabs are sorted by their current position (`index`) in ascending order. When a new tab is added to an existing group, it is moved to the first position of that group for easy access.

- **Interactive Popup**: The extension's popup provides a comprehensive overview and control:
  - **Active Groups List**: View all currently open tab groups across your windows, along with the number of tabs in each group. Each group item is color-coded to match its Chrome tab group color.
  - **Group Navigation**: Click on any group in the popup to instantly switch to the first tab within that group and bring its window to the front.
  - **Custom Rules Management**: Easily add and delete your custom regex grouping rules.
