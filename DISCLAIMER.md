# Disclaimer

## No Warranty

VS Code Todo is provided "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement. The complete warranty disclaimer is available in the [LICENSE](LICENSE) file.

## Limitation of Liability

In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software, including but not limited to:

- Data loss or corruption
- Service interruptions
- Sync conflicts resulting in overwritten data
- Unavailability of third-party services (GitHub, GitHub Gist)
- Security breaches of stored data
- Any other damages arising from use of this software

## User Responsibilities

By using VS Code Todo, you acknowledge and agree that:

1. **Backups**: You are solely responsible for maintaining backups of your data
2. **Security**: You will not store sensitive information (passwords, API keys, tokens) in todos
3. **Testing**: You will test the sync functionality before relying on it for critical data
4. **Third-party Services**: You understand the extension depends on GitHub's availability
5. **Conflicts**: You accept that sync conflicts use last-writer-wins resolution

## GitHub Gist Sync

The GitHub Gist sync feature:

- Depends on GitHub's service availability and API reliability
- Stores your data in plaintext JSON format on GitHub's servers
- Uses last-writer-wins conflict resolution that may result in data loss
- Requires you to secure your Gist ID and manage access permissions
- Is your responsibility to backup separately from the extension

## Data Privacy

This extension does not collect telemetry or analytics. When using GitHub Gist sync:

- Your data is stored on GitHub's servers (see [GitHub's Privacy Policy](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement))
- GitHub authentication is handled by VS Code's built-in OAuth system
- You control who has access to your Gist through GitHub's sharing settings

## Recommendations

To minimize risk when using VS Code Todo:

1. **Export regularly**: Use "Export to JSON" to create local backups
2. **Test first**: Try the sync feature with non-critical data initially
3. **Use secret Gists**: Create secret (not public) Gists for privacy
4. **Coordinate with teams**: When sharing Gists, coordinate edits to avoid conflicts
5. **Secure your settings**: Never commit `.vscode/settings.json` with Gist IDs to source control
6. **Monitor sync status**: Watch the status bar indicators for sync errors

## Third-Party Service Dependency

The GitHub Gist sync feature depends on:

- GitHub API availability and reliability
- Your GitHub account access and permissions
- Network connectivity

We are not responsible for GitHub service outages, API changes, rate limiting, or data loss resulting from GitHub service issues. GitHub's Terms of Service and Privacy Policy apply to data stored in Gists.

## Conflict Resolution Behavior

When both local and remote data have changed, the extension uses **last-writer-wins** based on GitHub's `updated_at` timestamp. This means:

- **Remote wins**: If remote data is newer, your local changes will be overwritten
- **No merge**: Changes are not combined or merged intelligently
- **Data loss possible**: Recent local work may be lost in conflict scenarios

**Protection**: Export your todos before making major changes or when working offline for extended periods.

## Legal Basis

This software is distributed under the MIT License. See the [LICENSE](LICENSE) file for the complete legal terms. This disclaimer supplements but does not replace the terms of the MIT License.

## Updates

This disclaimer may be updated from time to time. Continued use of the extension constitutes acceptance of any changes. Please check this file periodically for updates.

Last updated: January 2025

---

For questions or concerns, please visit the [GitHub repository](https://github.com/ai-autocoder/vscode-todo) or file an issue at the [issues page](https://github.com/ai-autocoder/vscode-todo/issues).
