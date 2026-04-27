# Changelog

## [0.4.0](https://github.com/coderage-labs/armada/compare/ui-v0.3.0...ui-v0.4.0) (2026-04-27)


### Features

* action step editor — repo dropdown from project repos + auto-discover actions ([722efb9](https://github.com/coderage-labs/armada/commit/722efb9f200352157ff354b571375b194a43b2ba))
* add Test button for linked notification channels on Account page ([ebeb4ad](https://github.com/coderage-labs/armada/commit/ebeb4ad69697cb0dc44ffc22a8279821b30dbc39))
* changeset impact detection — auto-apply zero-impact, scope restarts ([#83](https://github.com/coderage-labs/armada/issues/83)) ([#86](https://github.com/coderage-labs/armada/issues/86)) ([37ebad5](https://github.com/coderage-labs/armada/commit/37ebad5e8a4cd4bd142b9fe39ab0c532222faaff))
* click-to-highlight relationships + transparent filter (not removal) ([91e467a](https://github.com/coderage-labs/armada/commit/91e467a890bf468a0cac70529cbecc567bf6e997))
* deterministic colour palette for language colours ([73287ca](https://github.com/coderage-labs/armada/commit/73287caef5006739d0cd7ab19069e281b801f13c))
* dynamic language legend with toggle filtering on dependency graph ([9e29768](https://github.com/coderage-labs/armada/commit/9e29768465a1da766314131e19892e888f8ca582))
* force-directed graph layout with node sizing by importance ([8dba430](https://github.com/coderage-labs/armada/commit/8dba430bf6b7863b3f94457633dfba274aa7a490))
* full dependency graph endpoint + show all source files in visualiser ([5bcbd39](https://github.com/coderage-labs/armada/commit/5bcbd39efff519f6500a8637b89a081a2e50c166))
* manual triage modal — select workflow + fill vars for GitHub issues ([#106](https://github.com/coderage-labs/armada/issues/106)) ([#108](https://github.com/coderage-labs/armada/issues/108)) ([c36bdfa](https://github.com/coderage-labs/armada/commit/c36bdfaf4319e149d3fa20f434786ca402338900))
* per-project GitHub sync polling with integration auth ([#150](https://github.com/coderage-labs/armada/issues/150)) ([17e8269](https://github.com/coderage-labs/armada/commit/17e8269fcb3fe30b28c98a6cf537675b69ae77e8))
* project assignments UI — manage triager/approver/owner ([#117](https://github.com/coderage-labs/armada/issues/117)) ([#120](https://github.com/coderage-labs/armada/issues/120)) ([e14ba1c](https://github.com/coderage-labs/armada/commit/e14ba1c9fe715cabaa2afa1a8ab52995b2783c26))
* project settings — colour palette and emoji picker ([#138](https://github.com/coderage-labs/armada/issues/138)) ([#144](https://github.com/coderage-labs/armada/issues/144)) ([7dc6604](https://github.com/coderage-labs/armada/commit/7dc6604c05632effbcc7e16a09db3574dbc2bd24))
* real-time workflow DAG visualisation ([#10](https://github.com/coderage-labs/armada/issues/10)) ([#103](https://github.com/coderage-labs/armada/issues/103)) ([469e05a](https://github.com/coderage-labs/armada/commit/469e05abb6a1b9d7eb8292d4016b53f8a9297812))
* repo search-and-select UI on Project Settings ([#170](https://github.com/coderage-labs/armada/issues/170)) ([#178](https://github.com/coderage-labs/armada/issues/178)) ([d592f0a](https://github.com/coderage-labs/armada/commit/d592f0a329a246ddd63d7b9f36fdf80fc708eac2))
* show workflow step outputs in gate detail view ([#53](https://github.com/coderage-labs/armada/issues/53)) ([#93](https://github.com/coderage-labs/armada/issues/93)) ([bfbf834](https://github.com/coderage-labs/armada/commit/bfbf8344359b472ec9807afee63df37108995c0f))
* tool categories — tag all 242 tools, filter by category on demand ([#128](https://github.com/coderage-labs/armada/issues/128)) ([#145](https://github.com/coderage-labs/armada/issues/145)) ([3bca782](https://github.com/coderage-labs/armada/commit/3bca7820464b1abdf7affacb50afbe5a1003fcfc))
* **ui:** add Analytics dashboard page ([#197](https://github.com/coderage-labs/armada/issues/197)) ([7d87645](https://github.com/coderage-labs/armada/commit/7d876450a0c029a8b5fc893554db651bb19d1257))
* **ui:** Add codebase visualizer page ([#181](https://github.com/coderage-labs/armada/issues/181)) ([#182](https://github.com/coderage-labs/armada/issues/182)) ([d375723](https://github.com/coderage-labs/armada/commit/d375723c6324eb8a654bb57d213aff7b6f645c79))
* **ui:** Add Learning page with leaderboard, reviews, conventions, and agent lessons ([#198](https://github.com/coderage-labs/armada/issues/198)) ([03246d6](https://github.com/coderage-labs/armada/commit/03246d64c087c0c48cb742e1af425d397cfc74db))
* unified LoadingState component with rocket animation ([#79](https://github.com/coderage-labs/armada/issues/79)) ([#81](https://github.com/coderage-labs/armada/issues/81)) ([c5af7a1](https://github.com/coderage-labs/armada/commit/c5af7a1a9c7dfac8c01a262c41c97a669c1819c8))
* unified triage dispatch — single endpoint for humans and agents ([#106](https://github.com/coderage-labs/armada/issues/106)) ([#109](https://github.com/coderage-labs/armada/issues/109)) ([6d4a9d2](https://github.com/coderage-labs/armada/commit/6d4a9d223ce66c8d57ccecd046662d8e75e711f1))


### Bug Fixes

* Account page didn't extract channel types from notification-channels array ([b477679](https://github.com/coderage-labs/armada/commit/b4776790f4c82f92f160c9b64aab5815b64ac40e))
* add remove() to ChangesetService interface ([294e04a](https://github.com/coderage-labs/armada/commit/294e04a09e9ba366326f9705f482103ec405aa4e))
* add repo selector to codebase visualiser + list indexed repos endpoint ([a427fd5](https://github.com/coderage-labs/armada/commit/a427fd5623c250e1ab2c786fa7a5309f41307964))
* agents tab — topCategories is array of objects not strings, rank is object not string ([7f24693](https://github.com/coderage-labs/armada/commit/7f24693d0dd8cf29ff356200d7f4aa83677823cf))
* align exhaust trail with rocket nozzle position ([#79](https://github.com/coderage-labs/armada/issues/79)) ([c7617ca](https://github.com/coderage-labs/armada/commit/c7617cade98c1a300ac7d668f67178d5090b44bc))
* assignments display resolves agent/user names from fetched lists ([#137](https://github.com/coderage-labs/armada/issues/137)) ([#140](https://github.com/coderage-labs/armada/issues/140)) ([9d52c8d](https://github.com/coderage-labs/armada/commit/9d52c8de221d2cc5ee21865fd4384d2d7c1fca6c))
* assignments UI maps API response format + correct PUT handler ([c69c505](https://github.com/coderage-labs/armada/commit/c69c50599e7d72f70191342ed1b10477f5d361d8))
* bake rotate(-45deg) into animation keyframes so it doesn't get clobbered ([#79](https://github.com/coderage-labs/armada/issues/79)) ([8dcafa9](https://github.com/coderage-labs/armada/commit/8dcafa9a009e5659e808da144103544f1ed0c2e6))
* codebase visualiser bug fixes — types, colours, mobile, language detection ([de2df97](https://github.com/coderage-labs/armada/commit/de2df9731c3ea5d2d5f803849947cc3de0ef6ca2))
* dark theme zoom controls + allow zooming out to 5% to see full graph ([3be444e](https://github.com/coderage-labs/armada/commit/3be444e8762e786887e8b0d3baf1409035490ac9))
* darker colour palette — all readable with white text ([371c4d3](https://github.com/coderage-labs/armada/commit/371c4d34b9e934598ada45b483c72a0d2bc9f1d4))
* don't show stale completed changesets in bottom bar on page load ([f021789](https://github.com/coderage-labs/armada/commit/f021789d601f472f34844317e0f6d19d62ae7a23))
* exhaust trails go straight down, not 45 degrees ([#79](https://github.com/coderage-labs/armada/issues/79)) ([d8ac7a7](https://github.com/coderage-labs/armada/commit/d8ac7a7ea1fb56a7cec97c710563db4178156ef2))
* guard .length calls on optional fields in workflow detail UI ([c1e49bb](https://github.com/coderage-labs/armada/commit/c1e49bb99a98d6d638f8f976f8df548774d06d1a))
* guard step.sharedRefs with optional chaining — crashes on action steps ([237fdbd](https://github.com/coderage-labs/armada/commit/237fdbd8172674d92f09110700c278351862de99))
* handle rank as object in analytics agents tab (React error [#31](https://github.com/coderage-labs/armada/issues/31)) ([708a772](https://github.com/coderage-labs/armada/commit/708a7723598650a74de72101f835329a7fc8d67f))
* hide language legend when only one language in graph ([5bf1a16](https://github.com/coderage-labs/armada/commit/5bf1a167bfd7e99b694228fd12e92dd43281bfcc))
* iconify channel test/unlink buttons for mobile — use FlaskConical icon ([2e3a03c](https://github.com/coderage-labs/armada/commit/2e3a03c9eb186b8b8b005bb828b4168def22908e))
* import path resolution + UI field name mismatch in codebase visualiser ([0acfe6a](https://github.com/coderage-labs/armada/commit/0acfe6ae17cd6891ad1b21da67fdeea4431c2250))
* issue list UX — detail modal, working GitHub links, visible triage button ([#110](https://github.com/coderage-labs/armada/issues/110)) ([#111](https://github.com/coderage-labs/armada/issues/111)) ([92271f3](https://github.com/coderage-labs/armada/commit/92271f30d15fd3cf3e19d8027ee5a2076b4d5334))
* LoadingState now mirrors splash structure exactly — wrapper floats, SVG rotates, trail centered ([#79](https://github.com/coderage-labs/armada/issues/79)) ([bbe2561](https://github.com/coderage-labs/armada/commit/bbe2561f321062b1db115c53ad2da1988a3cfc03))
* members tab UI — use lucide icons, proper confirm dialog, drop role badge ([#74](https://github.com/coderage-labs/armada/issues/74)) ([61003f1](https://github.com/coderage-labs/armada/commit/61003f1933d45365acd8f6f1dba52cc9daed6be2))
* normalise tsx/jsx into TypeScript/JavaScript in graph legend + filter ([e351d14](https://github.com/coderage-labs/armada/commit/e351d148c3158d62908dc7ccdbfdb3013afdd1a7))
* project metrics, activity, and agents tabs populated from real data ([#134](https://github.com/coderage-labs/armada/issues/134)) ([#141](https://github.com/coderage-labs/armada/issues/141)) ([e8b6653](https://github.com/coderage-labs/armada/commit/e8b66534c297d200c92c7001c13949e8d513b4b9))
* project settings mobile layout — stack name/colour, icon full-width below, tighter grid ([12c5765](https://github.com/coderage-labs/armada/commit/12c57654519c866b76682cf916eda2f712d92783))
* prompt performance handles object response + collaboration thread URL path ([7edd616](https://github.com/coderage-labs/armada/commit/7edd616df1a4d6ff8cf939c3c7572ae9189f631b))
* reduce TabsContent margin to reduce 1px scroll overflow ([#142](https://github.com/coderage-labs/armada/issues/142)) ([c67d407](https://github.com/coderage-labs/armada/commit/c67d4075b8466d1ab200f0f989564580b9bceaf7))
* remove network topology from Tasks page — unused clutter ([739d3d9](https://github.com/coderage-labs/armada/commit/739d3d99918a3fae8aad16a4b79467d94243aa7d))
* remove rotation from rocket icons — use natural lucide orientation everywhere ([#79](https://github.com/coderage-labs/armada/issues/79)) ([6a355e0](https://github.com/coderage-labs/armada/commit/6a355e0e76626e4381a497d980575b3dae860bac))
* replace alert() with toast.error() in Models page ([f40f4ef](https://github.com/coderage-labs/armada/commit/f40f4efaf98f120975ecf7cae736632af912c1a9))
* replace remaining page-level loaders with LoadingState ([#79](https://github.com/coderage-labs/armada/issues/79)) ([83bb177](https://github.com/coderage-labs/armada/commit/83bb177b7456f2686d52871aec93fc0c386d370b))
* replace splash emoji with lucide Rocket SVG, align LoadingState with splash style ([#79](https://github.com/coderage-labs/armada/issues/79)) ([b47ce5b](https://github.com/coderage-labs/armada/commit/b47ce5bea644487d8fb365208353d654616ce467))
* replace title with aria-label on Lucide RefreshCw (ImpactBadge TS error) ([0cf7ea0](https://github.com/coderage-labs/armada/commit/0cf7ea01f1e45592931edd05f53abbf5ecbcabe3))
* replace window.prompt with proper AlertDialog for gate rejection ([2e154ea](https://github.com/coderage-labs/armada/commit/2e154ea34e7a3d45d653797ea1753960bceabd66))
* resolve all TypeScript compilation errors across monorepo ([#149](https://github.com/coderage-labs/armada/issues/149)) ([29becb1](https://github.com/coderage-labs/armada/commit/29becb116a3fa7d0844303f012211ce14bb0f5e7))
* rocket points up everywhere — rotate-45 on icon, trails straight down ([#79](https://github.com/coderage-labs/armada/issues/79)) ([aa51e97](https://github.com/coderage-labs/armada/commit/aa51e97845131e67e6865566e949cb43b107732c))
* scale force simulation for large repos — more repulsion, wider spacing ([e980cb5](https://github.com/coderage-labs/armada/commit/e980cb563680ba263d436486b512a760bf49da9a))
* separate migration v36 for html_url column ([df17938](https://github.com/coderage-labs/armada/commit/df17938d2eafc254349b13e56efae74ed4697c2b))
* sequential colour assignment — zero collisions guaranteed ([ec5447e](https://github.com/coderage-labs/armada/commit/ec5447e2cff46f8d075446fcfde8093d9b0ad5d8))
* simplify exhaust to single centered trail ([#79](https://github.com/coderage-labs/armada/issues/79)) ([8697461](https://github.com/coderage-labs/armada/commit/869746104855edd1be8162f7db496bb240e2c841))
* splash exhaust trails go straight down ([#79](https://github.com/coderage-labs/armada/issues/79)) ([c8cfbb8](https://github.com/coderage-labs/armada/commit/c8cfbb8ead9ffb54f5402be934f36640efdb48ad))
* store issue body in cache + filter triage workflows to project only ([8ad3a61](https://github.com/coderage-labs/armada/commit/8ad3a61c9cfc732b043c984383131ff73e1922d1))
* TabsList overflow-y-hidden to prevent vertical scrollbar on mobile ([b682682](https://github.com/coderage-labs/armada/commit/b682682fa665d82cfd4e4213fe40848911349c3f))
* test notification sends to user's linked channel, not system channel; fix mobile layout ([b2962eb](https://github.com/coderage-labs/armada/commit/b2962eb8c06c3c6ca16c454fac758d27c7b77b2b))
* treat TSX and JSX as separate languages from TypeScript/JavaScript ([087aceb](https://github.com/coderage-labs/armada/commit/087aceb5af7aa21618bd678c41b985e2b01e09b4))
* triaged issues filtered from list + remove redundant workflow filter in modal ([6db0aa7](https://github.com/coderage-labs/armada/commit/6db0aa79247bbb4ec09e40d18bc8b7f37e4cfa25))
* workflow list includes projectIds + triage modal uses projectId filter ([092c81f](https://github.com/coderage-labs/armada/commit/092c81ff88f4533a0e104c186144f0cdfe165c15))
* wrong API URL in workflow run detail + rework history (/api/workflow-runs/ → /api/workflows/runs/) ([c2e19fe](https://github.com/coderage-labs/armada/commit/c2e19fe43147026bb22380916201bea11807e92d))

## [0.3.0](https://github.com/coderage-labs/armada/compare/ui-v0.2.0...ui-v0.3.0) (2026-03-17)


### Features

* add project owner with mutex and triage escalation ([#75](https://github.com/coderage-labs/armada/issues/75)) ([3d5bfb5](https://github.com/coderage-labs/armada/commit/3d5bfb5d93c81471091868a31c9eaea28439b62a))

## [0.2.0](https://github.com/coderage-labs/armada/compare/ui-v0.1.0...ui-v0.2.0) (2026-03-16)


### Features

* Account page channel linking UI + admin modal channels support ([#63](https://github.com/coderage-labs/armada/issues/63)) ([#66](https://github.com/coderage-labs/armada/issues/66)) ([72e9c08](https://github.com/coderage-labs/armada/commit/72e9c08acae79310687417e95347b67e42a73880))
* add Public URL to Settings page, fix setup wizard step sizing and confirm-url guard ([d6a299c](https://github.com/coderage-labs/armada/commit/d6a299c5140058e418905146f347e1c7bbc67ac5))
* Armada v0.1.0 — AI agent orchestration platform ([fa7b689](https://github.com/coderage-labs/armada/commit/fa7b6896793e7a54d8fec4371373458dbc1a33e0))
* remove mDNS discovery, fix add-agent dialog ([654a32d](https://github.com/coderage-labs/armada/commit/654a32db8b060aa440024bc60ece3202269a9100))
* responsive dialogs (drawer on mobile) + shadcn tabs cleanup ([48432c7](https://github.com/coderage-labs/armada/commit/48432c729a6f1801a3456b60db9d784a39b65e03))
* rocket icon branding + fix Sidebar class→className bug ([860ccae](https://github.com/coderage-labs/armada/commit/860ccaea045299e6f0689d92865cedef4ffd9217))
* setup wizard — passkey only on HTTPS, password always available ([301accd](https://github.com/coderage-labs/armada/commit/301accd5648600151d4e7db241501818b0b4c15b))
* simplify installation — remove legacy tokens, auto-detect URL, expand setup wizard ([37ac3f2](https://github.com/coderage-labs/armada/commit/37ac3f27d86c2b5cc55d5303bcb63dc50647e19e))


### Bug Fixes

* correct agent plugin npm package name in step planner ([a7aaf46](https://github.com/coderage-labs/armada/commit/a7aaf46d33d01e40bf45cdf5e76a8669a3a5a45c))
* drawer over-scroll on mobile (scope max-h/overflow to desktop only) ([38dd1d8](https://github.com/coderage-labs/armada/commit/38dd1d8125c6332f170258e6f6880c282c5b1edc))
* install flow, test failures, and branding ([740d6f5](https://github.com/coderage-labs/armada/commit/740d6f5ae86cf6c46e8f1da1dedc0be3118aa4c1))
* mobile drawer padding, ConfirmDialog→drawer, title-case Armada everywhere ([dd40486](https://github.com/coderage-labs/armada/commit/dd404864e77036960f75b1131921acac304da8c6))
* notification system — self-edit prefs, account UI, bot token from config ([#54](https://github.com/coderage-labs/armada/issues/54)) ([#61](https://github.com/coderage-labs/armada/issues/61)) ([f843616](https://github.com/coderage-labs/armada/commit/f84361634239b51aca245a630d87b103f19c4cc3))
* require passkey during setup wizard ([36c2690](https://github.com/coderage-labs/armada/commit/36c2690329650c97419e816aedf72835d04db6b8))
* store all dates as ISO 8601, add passkey rename ([1aaa589](https://github.com/coderage-labs/armada/commit/1aaa589b1fafc1db06c6867b1a5f0ced550a2511))
* update NodeInstallModal curl command to use token-in-URL pattern ([b7c1505](https://github.com/coderage-labs/armada/commit/b7c1505fd337e7f43b42e112ab33af6c06243715))

## Changelog
