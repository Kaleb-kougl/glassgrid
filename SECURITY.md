# Security

Please report security problems privately. Use GitHub's **Report a
vulnerability** button on this repository's **Security** tab, not a public
issue. I'll reply within a week.

Relevant areas include:

- the Electron app's process isolation (sandboxed renderer, preload bridge,
  the engine `utilityProcess`);
- SQL built from user input in `packages/core`;
- `.glassgrid` workspace parsing;
- the web demo's Content Security Policy (`apps/web/csp.ts`).

Glassgrid is pre-1.0. Only the latest `main` is supported.
