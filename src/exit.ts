// The helper's exit codes. A file of its own, so the CLI can use them
// before it loads helper.js (and puppeteer).
export const EXIT = { stopped: 0, usage: 1, setup: 2, crashLoop: 3 } as const;
