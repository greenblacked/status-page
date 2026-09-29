# Git, commits, and README

Short rules Status Page follows so history stays readable.

## Commit messages

```text
<type>(<optional scope>): <imperative summary>

<optional body: why, not what>

<optional footer: Fixes #123>
```

### Good

```text
feat(status): add CS2 Europe relay coverage from Valve SDR config

GetGameServersStatus is key-gated. SDR pops plus player count are
the official public signals we can read without credentials.
```

```text
fix(apple): parse system_status_en_US.js instead of the retired JSON path
```

```text
docs(readme): list every official status URL in a source table
```

### Bad

```text
update
WIP
fixed stuff
Add files via upload
```

### Why this shape

- `type` makes `git log` and changelogs machine-sortable
- Imperative matches git’s own merge messages (`Merge pull request…`)
- Body captures the decision a future reader cannot recover from the diff
- One concern per commit keeps `git bisect` honest

## Authorship

- Author = the human GitHub user who intended the change
- Committer = whoever applied it (often the same person)
- Do not force-push shared branches
- Do not amend commits you have already pushed unless you own the branch and the PR is still in draft
- Sign commits (`git commit -S`) if your org requires it; Status Page does not require it yet

## README

A README is a product surface, not a dump of the repo tree. Keep this order:

1. **Name and one sentence** — what it is
2. **Why** — the problem
3. **What you get** — table or short list, not marketing
4. **Sources / truth** — for a status board, this is the contract
5. **How to use**
6. **How to develop** — only what a contributor must know
7. **Disclaimer and license**
8. **Link to contributing**

Avoid:

- Badges that do not map to a real check
- “Made with love”
- Pasting internal ports, container names, or tool logs
- Screenshots of Lorem ipsum

When behavior changes (new vendor, new health rule), update the README **in the same commit**.
