# Changelog

## [0.3.0](https://github.com/coderage-labs/armada/compare/armada-node-v0.2.0...armada-node-v0.3.0) (2026-04-27)


### Features

* add GPG signing support for agent commits ([#15](https://github.com/coderage-labs/armada/issues/15)) ([#257](https://github.com/coderage-labs/armada/issues/257)) ([584d9c0](https://github.com/coderage-labs/armada/commit/584d9c03b5ba3db7dbd6f715e2262a7e36b983c1))
* armada.json + auto-discovery + build verification before PR creation ([#172](https://github.com/coderage-labs/armada/issues/172)) ([#173](https://github.com/coderage-labs/armada/issues/173)) ([68c536c](https://github.com/coderage-labs/armada/commit/68c536c967d7a0bba82c3fb64292945a242daa2e))
* git worktrees per workflow step with lifecycle cleanup ([#175](https://github.com/coderage-labs/armada/issues/175)) ([#176](https://github.com/coderage-labs/armada/issues/176)) ([2d2ac8b](https://github.com/coderage-labs/armada/commit/2d2ac8b2af565436aa35e5d260f2b43b8fc04f03))
* pre-provision workspace before dispatching workflow steps ([#165](https://github.com/coderage-labs/armada/issues/165)) ([#167](https://github.com/coderage-labs/armada/issues/167)) ([54078c2](https://github.com/coderage-labs/armada/commit/54078c2a574337b0b93f14a9aa66c1db9dd9bca7))
* SSE-based log tailing for instances ([#12](https://github.com/coderage-labs/armada/issues/12)) ([#96](https://github.com/coderage-labs/armada/issues/96)) ([a73f1f2](https://github.com/coderage-labs/armada/commit/a73f1f2a4a3bb30103fa7b84fcfc21f6e6028c00))
* WebSocket relay — stream instance events to control plane ([#13](https://github.com/coderage-labs/armada/issues/13)) ([#98](https://github.com/coderage-labs/armada/issues/98)) ([7bf14f7](https://github.com/coderage-labs/armada/commit/7bf14f7d923e5355dc202a23965965784a973715))


### Bug Fixes

* absolute paths for SOUL.md/AGENTS.md writes in redeploy ([#206](https://github.com/coderage-labs/armada/issues/206)) ([#208](https://github.com/coderage-labs/armada/issues/208)) ([7aa904f](https://github.com/coderage-labs/armada/commit/7aa904f6645a1a74f179e69a1ba445f8dd86bb61))
* handle HTTP 502/503 during WS upgrade — retry instead of giving up ([#90](https://github.com/coderage-labs/armada/issues/90)) ([#91](https://github.com/coderage-labs/armada/issues/91)) ([511a72b](https://github.com/coderage-labs/armada/commit/511a72b97e050bab273fee18ad1af4bbcb4e051c))
* **node:** Chown files to node user (1000:1000) after writing to instance volumes ([#245](https://github.com/coderage-labs/armada/issues/245)) ([8affe27](https://github.com/coderage-labs/armada/commit/8affe271e1c2c5b5046c9eb112314c04a3a49330)), closes [#234](https://github.com/coderage-labs/armada/issues/234)
* reliable WS reconnection with ping/pong keepalive ([#78](https://github.com/coderage-labs/armada/issues/78)) ([#84](https://github.com/coderage-labs/armada/issues/84)) ([966d56d](https://github.com/coderage-labs/armada/commit/966d56d3efa49c855f4b3ef5094ca5b2c08b2af4))
* worktree paths use /home/node/ instead of /data/ (permission fix) ([4ff30c8](https://github.com/coderage-labs/armada/commit/4ff30c8e95796a8297eb26fa846f1083574e5cf2))

## [0.2.0](https://github.com/coderage-labs/armada/compare/armada-node-v0.1.0...armada-node-v0.2.0) (2026-03-16)


### Features

* Armada v0.1.0 — AI agent orchestration platform ([fa7b689](https://github.com/coderage-labs/armada/commit/fa7b6896793e7a54d8fec4371373458dbc1a33e0))
* remove mDNS discovery, fix add-agent dialog ([654a32d](https://github.com/coderage-labs/armada/commit/654a32db8b060aa440024bc60ece3202269a9100))


### Bug Fixes

* 25: Node agent auto-detects Docker network on startup ([4d16765](https://github.com/coderage-labs/armada/commit/4d167659d12f46dbbc5dfb07a58de364e12c3268))
* 27: Node agent falls back to install token after stale session credentials ([13818d5](https://github.com/coderage-labs/armada/commit/13818d54c3deedab0f4aed7a9f4c44ba4e87eaa3))
* proxy waits for WS connection instead of throwing immediately ([#47](https://github.com/coderage-labs/armada/issues/47)) ([#48](https://github.com/coderage-labs/armada/issues/48)) ([c0f2ae9](https://github.com/coderage-labs/armada/commit/c0f2ae910184dd3dda3abe027a81ccfda9f95eb4))
* three deployment pipeline bugs ([6088d6d](https://github.com/coderage-labs/armada/commit/6088d6d83d6e6c8c09747ff6274eba7ce2ad1601))

## Changelog
