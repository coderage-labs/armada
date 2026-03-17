# Changelog

## [0.3.0](https://github.com/coderage-labs/armada/compare/armada-v0.2.0...armada-v0.3.0) (2026-03-17)


### Features

* add project owner with mutex and triage escalation ([#75](https://github.com/coderage-labs/armada/issues/75)) ([3d5bfb5](https://github.com/coderage-labs/armada/commit/3d5bfb5d93c81471091868a31c9eaea28439b62a))


### Bug Fixes

* correct agent plugin workspace name in CI publish job ([a927154](https://github.com/coderage-labs/armada/commit/a927154b4c8b7b52722fa31f391721fb2fefc3f5))
* TypeScript compilation errors from Slack/Discord integration merge ([fa2f552](https://github.com/coderage-labs/armada/commit/fa2f552941cb6e2c17a56eb142592d48a0685b32))
* use releases_created global flag for publish job triggers ([95c56ee](https://github.com/coderage-labs/armada/commit/95c56ee9b20cbbcb155082c2703f5700b32bf0c4))

## [0.2.0](https://github.com/coderage-labs/armada/compare/armada-v0.1.0...armada-v0.2.0) (2026-03-16)


### Features

* Account page channel linking UI + admin modal channels support ([#63](https://github.com/coderage-labs/armada/issues/63)) ([#66](https://github.com/coderage-labs/armada/issues/66)) ([72e9c08](https://github.com/coderage-labs/armada/commit/72e9c08acae79310687417e95347b67e42a73880))
* add Public URL to Settings page, fix setup wizard step sizing and confirm-url guard ([d6a299c](https://github.com/coderage-labs/armada/commit/d6a299c5140058e418905146f347e1c7bbc67ac5))
* add scope to tool definitions and filter /api/meta/tools by token scopes ([#31](https://github.com/coderage-labs/armada/issues/31)) ([#49](https://github.com/coderage-labs/armada/issues/49)) ([213c4f8](https://github.com/coderage-labs/armada/commit/213c4f8633dfd2cbc8199bdbedea3c81eb154f8e))
* Armada v0.1.0 — AI agent orchestration platform ([fa7b689](https://github.com/coderage-labs/armada/commit/fa7b6896793e7a54d8fec4371373458dbc1a33e0))
* Discord bot integration — interactive notifications, DM linking, gate actions ([#63](https://github.com/coderage-labs/armada/issues/63)) ([#68](https://github.com/coderage-labs/armada/issues/68)) ([7d969f3](https://github.com/coderage-labs/armada/commit/7d969f39b2f3bb3dee409f6de9ac47b4ee84837c))
* harden notification delivery — system channel checks, quiet hours, clean delivery flow ([#63](https://github.com/coderage-labs/armada/issues/63)) ([#67](https://github.com/coderage-labs/armada/issues/67)) ([29cafb8](https://github.com/coderage-labs/armada/commit/29cafb85fbc6266dbcdcba6ddca86525ffe37ba6))
* implement loopUntilApproved — gate rejection loops back to target step with feedback ([2a5e687](https://github.com/coderage-labs/armada/commit/2a5e68725a6d57cdd8a98833c8426f118eaa228f))
* notification linking foundation — channels field, linking service, API endpoints ([#63](https://github.com/coderage-labs/armada/issues/63)) ([#64](https://github.com/coderage-labs/armada/issues/64)) ([8d4712a](https://github.com/coderage-labs/armada/commit/8d4712a519d4322ffbc147f5e67f1dd6cf6a1518))
* remove manual plugin tools, use API-defined tool defs ([#31](https://github.com/coderage-labs/armada/issues/31)) ([#51](https://github.com/coderage-labs/armada/issues/51)) ([5b63526](https://github.com/coderage-labs/armada/commit/5b63526d7672960d11668edbc7610eda84be865d))
* remove mDNS discovery, fix add-agent dialog ([654a32d](https://github.com/coderage-labs/armada/commit/654a32db8b060aa440024bc60ece3202269a9100))
* responsive dialogs (drawer on mobile) + shadcn tabs cleanup ([48432c7](https://github.com/coderage-labs/armada/commit/48432c729a6f1801a3456b60db9d784a39b65e03))
* rocket icon branding + fix Sidebar class→className bug ([860ccae](https://github.com/coderage-labs/armada/commit/860ccaea045299e6f0689d92865cedef4ffd9217))
* setup wizard — passkey only on HTTPS, password always available ([301accd](https://github.com/coderage-labs/armada/commit/301accd5648600151d4e7db241501818b0b4c15b))
* simplify installation — remove legacy tokens, auto-detect URL, expand setup wizard ([37ac3f2](https://github.com/coderage-labs/armada/commit/37ac3f27d86c2b5cc55d5303bcb63dc50647e19e))
* Slack app integration — interactive notifications, DM linking, gate actions ([#63](https://github.com/coderage-labs/armada/issues/63)) ([#69](https://github.com/coderage-labs/armada/issues/69)) ([bde1df4](https://github.com/coderage-labs/armada/commit/bde1df4bd9523728a4f1ed9b418e71de2acc3106))
* Telegram bot /start linking flow + unified identity for delivery and auth ([#63](https://github.com/coderage-labs/armada/issues/63)) ([#65](https://github.com/coderage-labs/armada/issues/65)) ([1a552ca](https://github.com/coderage-labs/armada/commit/1a552ca0457d97c18499bf90543a52e390601fe7))


### Bug Fixes

* 21: rebuildSteps now handles pending instance create mutations ([866d1f2](https://github.com/coderage-labs/armada/commit/866d1f2f8c578c11b78f61cabd9f064fce344b00))
* 25: Node agent auto-detects Docker network on startup ([4d16765](https://github.com/coderage-labs/armada/commit/4d167659d12f46dbbc5dfb07a58de364e12c3268))
* 27: Node agent falls back to install token after stale session credentials ([13818d5](https://github.com/coderage-labs/armada/commit/13818d54c3deedab0f4aed7a9f4c44ba4e87eaa3))
* account page token list shows only user's own tokens ([#50](https://github.com/coderage-labs/armada/issues/50)) ([#58](https://github.com/coderage-labs/armada/issues/58)) ([6417e76](https://github.com/coderage-labs/armada/commit/6417e76993b326d2234ad67406e4258b7b84f493))
* Add allowedOrigins to instance gateway config to prevent startup failures ([a3bba8e](https://github.com/coderage-labs/armada/commit/a3bba8ed7ffecc12edac8f31f9c0f19cd0e80362))
* add container provisioning step for fresh instances ([#21](https://github.com/coderage-labs/armada/issues/21)) ([ed3c923](https://github.com/coderage-labs/armada/commit/ed3c9234b06b4bfa42b31768f9d1cfcbff5d3e5b))
* add missing generateAuthProfiles and agentsRepo.getAll mocks in step-handlers tests ([cb75033](https://github.com/coderage-labs/armada/commit/cb750336d1244cdebf0eb83403edaab8782aaca7))
* Add test to verify workflow dispatch calls node relay ([#30](https://github.com/coderage-labs/armada/issues/30)) ([#33](https://github.com/coderage-labs/armada/issues/33)) ([1bd8751](https://github.com/coderage-labs/armada/commit/1bd87513f31a9a810d9e696cb034a8cb2f41b95d))
* all tests passing — integration auth, vitest config, plugin install test ([6337b76](https://github.com/coderage-labs/armada/commit/6337b76c29a87bec3e728baed7e2585c68fc1358))
* auto-create all schema tables on startup ([#57](https://github.com/coderage-labs/armada/issues/57)) ([#59](https://github.com/coderage-labs/armada/issues/59)) ([1d0dc10](https://github.com/coderage-labs/armada/commit/1d0dc106c4052e015ea20db3335a5ef3ec9cdc98))
* changeset pipeline for new instance creation ([b397b2b](https://github.com/coderage-labs/armada/commit/b397b2b50190152b450e31a53cc8d5827c211580))
* changeset preview handles new instance creation from working copy ([2f8c279](https://github.com/coderage-labs/armada/commit/2f8c2793ba77f0df5d8ca6609ea0d197f5787efa))
* config generator creates per-agent auth-profiles.json ([#34](https://github.com/coderage-labs/armada/issues/34)) ([#41](https://github.com/coderage-labs/armada/issues/41)) ([ac696fb](https://github.com/coderage-labs/armada/commit/ac696fb36fd318add39ad8d009bd010a7774cf27))
* config generator handles empty allowedOrigins gracefully ([#26](https://github.com/coderage-labs/armada/issues/26)) ([#60](https://github.com/coderage-labs/armada/issues/60)) ([1e844d8](https://github.com/coderage-labs/armada/commit/1e844d8d085ac9d1c054774ba454aaca15f55e31))
* correct agent plugin npm package name in step planner ([a7aaf46](https://github.com/coderage-labs/armada/commit/a7aaf46d33d01e40bf45cdf5e76a8669a3a5a45c))
* correct tool def paths for workflow context and rework endpoints ([98ae047](https://github.com/coderage-labs/armada/commit/98ae047c412fc278e7c4f86b58d617c0a6bc8945))
* don't auto-store origin from internal requests ([bbb8a4c](https://github.com/coderage-labs/armada/commit/bbb8a4c25389fbc20495c8df4e7f18d1b67bae23))
* drawer over-scroll on mobile (scope max-h/overflow to desktop only) ([38dd1d8](https://github.com/coderage-labs/armada/commit/38dd1d8125c6332f170258e6f6880c282c5b1edc))
* generate scoped API token for instance plugin + correct proxy hostname ([4bbe21d](https://github.com/coderage-labs/armada/commit/4bbe21da8a16628437bf20ccbe137e356d7672c9))
* handle activeTaskIds in processHeartbeat, backward-compat with array ([#46](https://github.com/coderage-labs/armada/issues/46)) ([941603a](https://github.com/coderage-labs/armada/commit/941603a70eff80c81881f05b4b48c490b5d775c8))
* handle wildcard scope in auth middleware ([75259fd](https://github.com/coderage-labs/armada/commit/75259fded46d2c891a0203ec1a09146d9ed32cda))
* install flow, test failures, and branding ([740d6f5](https://github.com/coderage-labs/armada/commit/740d6f5ae86cf6c46e8f1da1dedc0be3118aa4c1))
* make Docker network name configurable via ARMADA_NETWORK_NAME env var ([f8722d5](https://github.com/coderage-labs/armada/commit/f8722d507d52e66f18efdc5d8f91c36ed933e917))
* map dependsOn to waitFor in workflow steps ([#29](https://github.com/coderage-labs/armada/issues/29)) ([#32](https://github.com/coderage-labs/armada/issues/32)) ([8c3c019](https://github.com/coderage-labs/armada/commit/8c3c019d291813a4b6eea2863d6e18d2cdaccb05))
* mobile drawer padding, ConfirmDialog→drawer, title-case Armada everywhere ([dd40486](https://github.com/coderage-labs/armada/commit/dd404864e77036960f75b1131921acac304da8c6))
* network created by compose, not external ([c8f7c3f](https://github.com/coderage-labs/armada/commit/c8f7c3fd8036660d7fba7c3e3d956a5d9d777441))
* normalize model IDs by stripping date suffixes ([#38](https://github.com/coderage-labs/armada/issues/38)) ([#43](https://github.com/coderage-labs/armada/issues/43)) ([2b416b7](https://github.com/coderage-labs/armada/commit/2b416b7cc7969862d93f5afef3b4ebcf1b2d40a5))
* notification system — self-edit prefs, account UI, bot token from config ([#54](https://github.com/coderage-labs/armada/issues/54)) ([#61](https://github.com/coderage-labs/armada/issues/61)) ([f843616](https://github.com/coderage-labs/armada/commit/f84361634239b51aca245a630d87b103f19c4cc3))
* onStepCompleted must not overwrite waiting_for_rework status ([e975859](https://github.com/coderage-labs/armada/commit/e9758596cb00277c4add9040d5d083658ff62921))
* parse JSON scopes in auth middleware ([#35](https://github.com/coderage-labs/armada/issues/35)) ([#39](https://github.com/coderage-labs/armada/issues/39)) ([5784497](https://github.com/coderage-labs/armada/commit/578449701719e477ea244216d0c1346c0e49b4fd))
* per-agent heartbeat accepts activeTasks as alias for taskCount ([#46](https://github.com/coderage-labs/armada/issues/46)) ([ff1fead](https://github.com/coderage-labs/armada/commit/ff1fead8311425d6d3a13c31efe840e8f36177ed))
* pre-generate auth token in config generator to prevent first-boot config overwrite ([e3abe2b](https://github.com/coderage-labs/armada/commit/e3abe2b7b90fd7783a494fdb3657f7bf041f879e))
* prevent duplicate pending mutations in working copy (fixes [#22](https://github.com/coderage-labs/armada/issues/22)) ([0383c9e](https://github.com/coderage-labs/armada/commit/0383c9e65c739bc162de3a3d199a361988ccbf58))
* propagate task result to workflow step output ([#36](https://github.com/coderage-labs/armada/issues/36)) ([#40](https://github.com/coderage-labs/armada/issues/40)) ([efc0e05](https://github.com/coderage-labs/armada/commit/efc0e05ac4022659ef2abcdc16618e916a8dde7b))
* proxy waits for WS connection instead of throwing immediately ([#47](https://github.com/coderage-labs/armada/issues/47)) ([#48](https://github.com/coderage-labs/armada/issues/48)) ([c0f2ae9](https://github.com/coderage-labs/armada/commit/c0f2ae910184dd3dda3abe027a81ccfda9f95eb4))
* remove dangerouslyAllowHostHeaderOriginFallback from instance configs (fixes [#23](https://github.com/coderage-labs/armada/issues/23)) ([c230ec8](https://github.com/coderage-labs/armada/commit/c230ec8b3ebe47193f3ea1cb9867b7f33408f892))
* remove hardcoded seed users ([7374d64](https://github.com/coderage-labs/armada/commit/7374d645b8dbad52bd1a8a69293ee29c5db942b5))
* require passkey during setup wizard ([36c2690](https://github.com/coderage-labs/armada/commit/36c2690329650c97419e816aedf72835d04db6b8))
* send activeTasks as number in heartbeat, not array ([#46](https://github.com/coderage-labs/armada/issues/46)) ([b472664](https://github.com/coderage-labs/armada/commit/b472664584a935070bd246638e30c5abd6c0ec38))
* single armada-net network for all containers ([15f42cc](https://github.com/coderage-labs/armada/commit/15f42cc57329966a906e063e192debb8a8ab6a3b))
* skip post-boot tasks in restart cleanup ([#44](https://github.com/coderage-labs/armada/issues/44)) ([#45](https://github.com/coderage-labs/armada/issues/45)) ([ffc4db7](https://github.com/coderage-labs/armada/commit/ffc4db7eaadfa091179e68aaeb422c45e0b6cbfd))
* store all dates as ISO 8601, add passkey rename ([1aaa589](https://github.com/coderage-labs/armada/commit/1aaa589b1fafc1db06c6867b1a5f0ced550a2511))
* strip content-length from proxied headers to prevent body truncation ([#44](https://github.com/coderage-labs/armada/issues/44)) ([280e3bf](https://github.com/coderage-labs/armada/commit/280e3bf1653a3a8af81600b760d8c43bd0118b79))
* strip duplicate content-type from proxied headers — Express ignores body with dupes ([d4323ca](https://github.com/coderage-labs/armada/commit/d4323ca18ebc52dac2370ea92923840ca38145c1))
* three deployment pipeline bugs ([6088d6d](https://github.com/coderage-labs/armada/commit/6088d6d83d6e6c8c09747ff6274eba7ce2ad1601))
* update NodeInstallModal curl command to use token-in-URL pattern ([b7c1505](https://github.com/coderage-labs/armada/commit/b7c1505fd337e7f43b42e112ab33af6c06243715))
* use bind mount for node agent data dir ([a59e36d](https://github.com/coderage-labs/armada/commit/a59e36da3ab8daf36d127e7915bc803ee6e6adbe))
* use dangerouslyAllowHostHeaderOriginFallback for instance configs ([b1ca4b7](https://github.com/coderage-labs/armada/commit/b1ca4b7ee4ef2512d8bf60179216b0863cdc5c16))
* use instance proxyUrl for task callback URL ([#37](https://github.com/coderage-labs/armada/issues/37)) ([#42](https://github.com/coderage-labs/armada/issues/42)) ([7a84879](https://github.com/coderage-labs/armada/commit/7a84879ed03675a4382953bc5a2c915cbb3e3c28))

## Changelog
