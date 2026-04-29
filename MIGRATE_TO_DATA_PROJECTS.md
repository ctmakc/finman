Legacy project location marker

This repository still lives physically at:
- `/home/llm/projects/finman`

Canonical target location:
- `/data/projects/finman`

Why this marker exists:
- The workspace storage rule is that projects belong under `/data/projects`.
- This repo was left in `/home/llm/projects` because a live process was using the old path during migration.

What the next agent should do before normal repo work:
1. Stop any process still running from `/home/llm/projects/finman`.
2. Move/sync the repository to `/data/projects/finman`.
3. Recreate `/home/llm/projects/finman` as a symlink to `/data/projects/finman`.
4. Restart the same process from the canonical location if it was running before.
5. Remove this marker after the migration is complete.

Observed live process at the time of marking:
- `node server.js`
