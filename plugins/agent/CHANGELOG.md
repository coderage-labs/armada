# Changelog

## [0.3.0](https://github.com/coderage-labs/armada/compare/armada-agent-plugin-v0.2.0...armada-agent-plugin-v0.3.0) (2026-04-27)


### Features

* agent plugin passes agent name for role-filtered tool loading ([#123](https://github.com/coderage-labs/armada/issues/123)) ([#125](https://github.com/coderage-labs/armada/issues/125)) ([c1eedc5](https://github.com/coderage-labs/armada/commit/c1eedc5c83c4a50d27260eae8471aacc03f4f17a))
* **agent:** Add armada_unload_tools for context management ([#147](https://github.com/coderage-labs/armada/issues/147)) ([#251](https://github.com/coderage-labs/armada/issues/251)) ([a1b0288](https://github.com/coderage-labs/armada/commit/a1b028833c0e151fd1ea20084eb92bbbdc7a2e0a))
* dynamic tool loading via armada_find_tools meta-tool ([#146](https://github.com/coderage-labs/armada/issues/146)) ([95670dc](https://github.com/coderage-labs/armada/commit/95670dc50bb7df136e668b3f57dad1925147f584))
* tool categories — tag all 242 tools, filter by category on demand ([#128](https://github.com/coderage-labs/armada/issues/128)) ([#145](https://github.com/coderage-labs/armada/issues/145)) ([3bca782](https://github.com/coderage-labs/armada/commit/3bca7820464b1abdf7affacb50afbe5a1003fcfc))
* workflow cancel aborts running agent tasks via /armada/abort ([#133](https://github.com/coderage-labs/armada/issues/133)) ([#136](https://github.com/coderage-labs/armada/issues/136)) ([0459359](https://github.com/coderage-labs/armada/commit/0459359c1c927eab684f483a2123b22b1632aea8))


### Bug Fixes

* add 'codebase' to armada_find_tools category hint list ([9a32b3c](https://github.com/coderage-labs/armada/commit/9a32b3cd41542b2f3c84e3c78839a58a90ba86cf))
* agent plugin configures git credential store on startup ([3e70165](https://github.com/coderage-labs/armada/commit/3e70165fc2cf1b7ba34d916f081a9b4649c4f829))
* artifact download saves to workspace — agents use file tools to inspect ([844e8d4](https://github.com/coderage-labs/armada/commit/844e8d4384c7c3835ed0f4f5f4ccd2459511aec7))
* copy git credentials to ~/.git-credentials on agent startup ([9741fc6](https://github.com/coderage-labs/armada/commit/9741fc6e6c7418accff2e89287b4155388e33903))
* sessions tagged with agentName from plugin — proper per-agent filtering ([6cb865b](https://github.com/coderage-labs/armada/commit/6cb865b4857f26901c0a9e6b365ade1b4429623c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @coderage-labs/armada-plugin-shared bumped from 0.2.0 to 0.2.1

## [0.2.0](https://github.com/coderage-labs/armada/compare/armada-agent-plugin-v0.1.0...armada-agent-plugin-v0.2.0) (2026-03-16)


### Features

* Armada v0.1.0 — AI agent orchestration platform ([fa7b689](https://github.com/coderage-labs/armada/commit/fa7b6896793e7a54d8fec4371373458dbc1a33e0))
* remove manual plugin tools, use API-defined tool defs ([#31](https://github.com/coderage-labs/armada/issues/31)) ([#51](https://github.com/coderage-labs/armada/issues/51)) ([5b63526](https://github.com/coderage-labs/armada/commit/5b63526d7672960d11668edbc7610eda84be865d))


### Bug Fixes

* send activeTasks as number in heartbeat, not array ([#46](https://github.com/coderage-labs/armada/issues/46)) ([b472664](https://github.com/coderage-labs/armada/commit/b472664584a935070bd246638e30c5abd6c0ec38))
* skip post-boot tasks in restart cleanup ([#44](https://github.com/coderage-labs/armada/issues/44)) ([#45](https://github.com/coderage-labs/armada/issues/45)) ([ffc4db7](https://github.com/coderage-labs/armada/commit/ffc4db7eaadfa091179e68aaeb422c45e0b6cbfd))
* three deployment pipeline bugs ([6088d6d](https://github.com/coderage-labs/armada/commit/6088d6d83d6e6c8c09747ff6274eba7ce2ad1601))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @coderage-labs/armada-plugin-shared bumped from 0.1.1 to 0.2.0

## Changelog
