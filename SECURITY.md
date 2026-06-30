# Security policy

Use GitHub private vulnerability reporting when available. Do not disclose exploitable archive traversal, command execution, report injection, browser isolation, or clipboard injection issues in a public issue before a fix is available.

LaunchCheck processes untrusted files. Contributions must preserve these boundaries:

- extracted ZIP entries must remain inside the temporary extraction root
- arbitrary downloaded executables and scripts must not be launched automatically
- browser automation must remain scoped to declared local HTML entry points
- report HTML must escape untrusted content
- clipboard content must be treated as data, not instructions
