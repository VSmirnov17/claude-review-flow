# review-flow

## Project

- Stack: a Claude Code plugin. Agents and skills are Markdown prompts in `agents/` and `skills/`. The gate is one dependency-free ES module, `skills/setup/templates/github/review-flow/review-flow.mjs`, run by `actions/github-script`.
- Conventions: the repository root is both the marketplace and the plugin. Templates that `setup` copies into other projects live in `skills/setup/templates/`. `.github/` in this repository is this repository's own installation of those templates.
- Goals: carry the layered review process from the article into any GitHub project with as little manual work as possible.
- Non-goals: replacing CI, hosting a service, or depending on npm packages.

Keep this file short and link to other docs for detail. Review flags code that breaks a convention here, and changes that make a line here out of date.

## Checks

Run these before saying a change is done, and show their output.

- Test: `npm test`
- Plugin manifest: `claude plugin validate .`
- Workflows: `actionlint .github/workflows/*.yml skills/setup/templates/github/workflows/*.yml`
- Gate copy: `.github/review-flow/review-flow.mjs` must be identical to the template. Change the template, then copy it.
