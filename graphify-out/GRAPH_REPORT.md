# Graph Report - .  (2026-05-29)

## Corpus Check
- 163 files · ~185,972 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1521 nodes · 3137 edges · 75 communities (63 shown, 12 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 48 edges (avg confidence: 0.81)
- Token cost: 22,600 input · 8,400 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Managed API Billing & Sessions|Managed API Billing & Sessions]]
- [[_COMMUNITY_Local Browser Tool Execution|Local Browser Tool Execution]]
- [[_COMMUNITY_Analytics, Dashboard & Site Patterns|Analytics, Dashboard & Site Patterns]]
- [[_COMMUNITY_Session & Tab Context Management|Session & Tab Context Management]]
- [[_COMMUNITY_Network Interception & Page Reading|Network Interception & Page Reading]]
- [[_COMMUNITY_Package Config & CLI Entry Points|Package Config & CLI Entry Points]]
- [[_COMMUNITY_Domain Skills Registry|Domain Skills Registry]]
- [[_COMMUNITY_CDP Anti-Bot & Mouse Simulation|CDP Anti-Bot & Mouse Simulation]]
- [[_COMMUNITY_Managed API Database Layer|Managed API Database Layer]]
- [[_COMMUNITY_MCP Message Payload Builders|MCP Message Payload Builders]]
- [[_COMMUNITY_Agent Config & LLM Interface|Agent Config & LLM Interface]]
- [[_COMMUNITY_Dashboard Chat UI|Dashboard Chat UI]]
- [[_COMMUNITY_License & Usage Tracking|License & Usage Tracking]]
- [[_COMMUNITY_Skills & Task Workflow Patterns|Skills & Task Workflow Patterns]]
- [[_COMMUNITY_Managed Task & LLM Proxy|Managed Task & LLM Proxy]]
- [[_COMMUNITY_Relay Integration Tests|Relay Integration Tests]]
- [[_COMMUNITY_LLM Client & Cost Tracking|LLM Client & Cost Tracking]]
- [[_COMMUNITY_Tool Execution & Tab Resolution|Tool Execution & Tab Resolution]]
- [[_COMMUNITY_Session Recovery & Internal Tasks|Session Recovery & Internal Tasks]]
- [[_COMMUNITY_Tab Group Management|Tab Group Management]]
- [[_COMMUNITY_Captcha Solving|Captcha Solving]]
- [[_COMMUNITY_WebSocket Connection Layer|WebSocket Connection Layer]]
- [[_COMMUNITY_Type Definitions & Content Blocks|Type Definitions & Content Blocks]]
- [[_COMMUNITY_API Auth & Task Step Building|API Auth & Task Step Building]]
- [[_COMMUNITY_DOM Field Label Resolution|DOM Field Label Resolution]]
- [[_COMMUNITY_Domain Skills Loader|Domain Skills Loader]]
- [[_COMMUNITY_Claude API Proxy & Credentials|Claude API Proxy & Credentials]]
- [[_COMMUNITY_Pairing Token Tests|Pairing Token Tests]]
- [[_COMMUNITY_Managed API Initialization|Managed API Initialization]]
- [[_COMMUNITY_CDP Debugger & Screenshots|CDP Debugger & Screenshots]]
- [[_COMMUNITY_Learned Plan Persistence|Learned Plan Persistence]]
- [[_COMMUNITY_OAuth Token Exchange|OAuth Token Exchange]]
- [[_COMMUNITY_LLM Provider Base Class|LLM Provider Base Class]]
- [[_COMMUNITY_Agent Loop Unit Tests|Agent Loop Unit Tests]]
- [[_COMMUNITY_API Key CRUD Tests|API Key CRUD Tests]]
- [[_COMMUNITY_Multi-Provider LLM Routing|Multi-Provider LLM Routing]]
- [[_COMMUNITY_Conversation Debug Log|Conversation Debug Log]]
- [[_COMMUNITY_MCP Architecture Documentation|MCP Architecture Documentation]]
- [[_COMMUNITY_Telemetry & Config Paths|Telemetry & Config Paths]]
- [[_COMMUNITY_MCP Task Handlers|MCP Task Handlers]]
- [[_COMMUNITY_Task Usage Tracking|Task Usage Tracking]]
- [[_COMMUNITY_Dashboard Dependencies|Dashboard Dependencies]]
- [[_COMMUNITY_DeepSeek LLM Provider|DeepSeek LLM Provider]]
- [[_COMMUNITY_Task Start & Debugger Lifecycle|Task Start & Debugger Lifecycle]]
- [[_COMMUNITY_Context Compaction|Context Compaction]]
- [[_COMMUNITY_Relay Connection Management|Relay Connection Management]]
- [[_COMMUNITY_TypeScript Compiler Config|TypeScript Compiler Config]]
- [[_COMMUNITY_Anthropic LLM Provider|Anthropic LLM Provider]]
- [[_COMMUNITY_DOM Selector & Value Classifier|DOM Selector & Value Classifier]]
- [[_COMMUNITY_Extension UI Indicators|Extension UI Indicators]]
- [[_COMMUNITY_DOM Form Interaction|DOM Form Interaction]]
- [[_COMMUNITY_HTTP Request Helpers|HTTP Request Helpers]]
- [[_COMMUNITY_Auth Session Resolution|Auth Session Resolution]]
- [[_COMMUNITY_Native Host IPC Connection|Native Host IPC Connection]]
- [[_COMMUNITY_Conversation Checkpoint|Conversation Checkpoint]]
- [[_COMMUNITY_Live End-to-End Tests|Live End-to-End Tests]]
- [[_COMMUNITY_SDK Session Types|SDK Session Types]]
- [[_COMMUNITY_Accessibility Tree Builder|Accessibility Tree Builder]]
- [[_COMMUNITY_Automation Scout & Post Scheduler|Automation Scout & Post Scheduler]]
- [[_COMMUNITY_Stripe Billing & Credits|Stripe Billing & Credits]]
- [[_COMMUNITY_LLM Content Block Types|LLM Content Block Types]]
- [[_COMMUNITY_Follow-up Message Tests|Follow-up Message Tests]]
- [[_COMMUNITY_Auth Mode Config|Auth Mode Config]]
- [[_COMMUNITY_Dashboard App & API Client|Dashboard App & API Client]]
- [[_COMMUNITY_DOM Element Resolver|DOM Element Resolver]]
- [[_COMMUNITY_Tool Result Formatting|Tool Result Formatting]]
- [[_COMMUNITY_Tool Definitions Filter|Tool Definitions Filter]]
- [[_COMMUNITY_example.com Site Knowledge|example.com Site Knowledge]]
- [[_COMMUNITY_google.com Site Knowledge|google.com Site Knowledge]]
- [[_COMMUNITY_httpbin.org Site Knowledge|httpbin.org Site Knowledge]]
- [[_COMMUNITY_HackerNews Site Knowledge|HackerNews Site Knowledge]]

## God Nodes (most connected - your core abstractions)
1. `db()` - 45 edges
2. `CDPHelper` - 40 edges
3. `runAgentLoop()` - 38 edges
4. `runAll()` - 26 edges
5. `startMcpTaskInternal()` - 25 edges
6. `assert()` - 25 edges
7. `Domain Skills Registry` - 24 edges
8. `startTask()` - 22 edges
9. `ensureDebugger()` - 21 edges
10. `runSetup()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Onboarding UI Entry Point` --conceptually_related_to--> `hanzi-browse Server Package`  [INFERRED]
  src/onboarding/index.html → server/package.json
- `bruteForceSolver()` --calls--> `sleep()`  [INFERRED]
  src/background/modules/captcha-solvers.js → server/src/cli/setup.ts
- `Side Panel Preact UI Entry Point` --conceptually_related_to--> `Preact UI Library`  [INFERRED]
  src/sidepanel-preact/index.html → server/dashboard/package.json
- `devhunt.org Site Knowledge` --conceptually_related_to--> `hanzi-browse Server Package`  [INFERRED]
  server/knowledge/sites/devhunt.org.md → server/package.json
- `Dashboard Web UI Entry Point` --implements--> `hanzi-dashboard Preact App`  [INFERRED]
  server/dashboard/index.html → server/dashboard/package.json

## Hyperedges (group relationships)
- **ATS Domain Skills (Workday, Greenhouse, Lever, Ashby, iCIMS, SmartRecruiters)** — domain_skill_workday, domain_skill_greenhouse, domain_skill_lever, domain_skill_ashby, domain_skill_icims, domain_skill_smartrecruiters, file_upload_shadow_dom, token_efficiency_pattern [INFERRED 0.95]
- **MCP → Relay → Extension Browser Execution Pipeline** — arch_mcp_server, arch_relay_server, arch_extension_bridge, arch_service_worker [EXTRACTED 1.00]
- **Job Aggregator → ATS Apply Navigation Flow** — domain_skill_simplifyjobs, domain_skill_jobright, domain_skill_linkedin, tabs_context_pattern, domain_skill_workday, domain_skill_greenhouse, domain_skill_lever [INFERRED 0.85]
- **All Workflow Skills Use browser_start as Core Execution Tool** — skill_a11y_auditor, skill_competitor_monitor, skill_data_extractor, skill_e2e_tester, skill_job_applier, skill_linkedin_prospector, skill_seo_checker, skill_social_poster, skill_x_marketer, mcp_tool_browser_start [EXTRACTED 1.00]
- **Pairing Templates + Extension + Ping Protocol Form Browser Connection Flow** — template_pair_html, template_pair_self_html, hanzi_browse_chrome_extension, hanzi_ping_message_protocol, hanzi_extension_pairing_protocol [EXTRACTED 1.00]
- **All Skills Require browser_status Preflight Check Before Proceeding** — mcp_tool_browser_status, skill_a11y_auditor, skill_competitor_monitor, skill_data_extractor, skill_e2e_tester, skill_job_applier, skill_linkedin_prospector, skill_seo_checker, skill_social_poster, skill_x_marketer [EXTRACTED 1.00]

## Communities (75 total, 12 thin omitted)

### Community 0 - "Managed API Billing & Sessions"
Cohesion: 0.07
Nodes (60): addCredits(), ApiKey, BrowserSession, checkTaskAllowance(), consumePairingToken(), createApiKey(), createAutomation(), createDraftBatch() (+52 more)

### Community 1 - "Local Browser Tool Execution"
Cohesion: 0.08
Nodes (15): ToolResult, LocalBrowser, READ_PAGE_SCRIPT, CdpSession, CdpTargetInfo, createOrAttachTarget(), arg(), has() (+7 more)

### Community 2 - "Analytics, Dashboard & Site Patterns"
Cohesion: 0.05
Nodes (50): Anti-Bot Site Pattern, Dashboard Web UI Entry Point, hanzi-dashboard Preact App, posthog-js Frontend Analytics, Preact UI Library, @sentry/browser Frontend Monitoring, Vite Build Tool, Amazon Domain Skill (+42 more)

### Community 3 - "Session & Tab Context Management"
Cohesion: 0.07
Nodes (44): activeSessions, agentOpenedTabs, buildLoopKey(), buildTabContext(), _cacheKey(), capturedScreenshotsByScope, detectActionLoop(), ensureContentScripts() (+36 more)

### Community 4 - "Network Interception & Page Reading"
Cohesion: 0.07
Nodes (37): extractJsonLd(), formatJsonLdSection(), initNetworkInterception(), interceptedResponses, CANDIDATE_TAGS, captureSnapshotPhased(), CLICK_EVENTS, collectCandidateIds() (+29 more)

### Community 5 - "Package Config & CLI Entry Points"
Cohesion: 0.04
Nodes (48): author, bin, hanzi-browse, hanzi-browser, hanzi-relay, dependencies, @anthropic-ai/sdk, better-auth (+40 more)

### Community 6 - "Domain Skills Registry"
Cohesion: 0.08
Nodes (38): __dirname, DOMAIN_SKILLS, DomainEntry, __filename, getDomainSkill(), AgentLoopParams, AgentLoopResult, pruneOldScreenshots() (+30 more)

### Community 7 - "CDP Anti-Bot & Mouse Simulation"
Cohesion: 0.07
Nodes (8): ANTI_BOT_CONFIG, calculateOvershoot(), CDPHelper, generateBezierPath(), humanDelay(), randomDelay(), KEY_DEFINITIONS, MAC_COMMANDS

### Community 8 - "Managed API Database Layer"
Cohesion: 0.06
Nodes (19): BrowserSession, data, DATA_DIR, dataPath(), deleteApiKey(), deleteBrowserSession(), disconnectSession(), hashSecret() (+11 more)

### Community 9 - "MCP Message Payload Builders"
Cohesion: 0.13
Nodes (38): buildScreenshotPayload(), buildStatusPayload(), buildStopPayload(), buildTaskCompletePayload(), buildTaskErrorPayload(), appendSessionLog(), createInitialStatus(), deleteSessionFiles() (+30 more)

### Community 10 - "Agent Config & LLM Interface"
Cohesion: 0.10
Nodes (38): AccessMode, AgentConfig, AgentRegistryDeps, ask(), BrowserDetectionDeps, BrowserInfo, BROWSERS, buildBrowserOpenCommand() (+30 more)

### Community 11 - "Dashboard Chat UI"
Cohesion: 0.09
Nodes (23): AGENT_EXAMPLES, EmptyState(), HUMAN_EXAMPLES, MessageList(), PlanModal(), SettingsModal(), CODEX_MODELS, LOCAL_MODELS (+15 more)

### Community 12 - "License & Usage Tracking"
Cohesion: 0.08
Nodes (31): checkAndIncrementUsage(), getLicenseStatus(), PROMPT_TEMPLATES, PROMPTS, __skillDir, TOOLS, callTextModel(), checkExtensionOnce() (+23 more)

### Community 13 - "Skills & Task Workflow Patterns"
Cohesion: 0.13
Nodes (35): Accessibility Audit Phases (Codebase/Visual/Keyboard/ARIA), Browser Tool Selection Rule (Prefer Non-Browser First), Competitor Snapshot Storage Pattern, Data Extraction Safety and Rate Limiting Rules, E2E Tester Production URL Safety Check, Hanzi Browse Chrome Extension, Hanzi Extension Pairing Protocol, HANZI_PING Extension Detection Protocol (+27 more)

### Community 14 - "Managed Task & LLM Proxy"
Cohesion: 0.09
Nodes (25): startManagedTask(), CCPROXY_MODEL_MAP, debugLog(), ensureBridgeSession(), getManagedSessionInfo(), getSourceClientId(), handleLLMRequest(), handleMcpCommand() (+17 more)

### Community 15 - "Relay Integration Tests"
Cohesion: 0.23
Nodes (28): assert(), mockRelay, req(), runAll(), testApiKeyCRUD(), testApiKeyWorkspaceIsolation(), testAuthRequired(), testBillingCheckoutEndpoint() (+20 more)

### Community 16 - "LLM Client & Cost Tracking"
Cohesion: 0.15
Nodes (25): abortRequest(), buildEffectiveConfig(), calcApiCostUsd(), callLLM(), callLLMSimple(), callLLMSimpleViaProxy(), callLLMSimpleViaProxyNoTools(), callLLMSimpleViaRelayProxy() (+17 more)

### Community 17 - "Tool Execution & Tab Resolution"
Cohesion: 0.11
Nodes (26): executeTool(), resolveActiveTab(), attachedTabs, clearConsoleMessages(), clearDebuggerSession(), clearNetworkRequests(), ensureSessionState(), getCapturedCaptchaData() (+18 more)

### Community 18 - "Session Recovery & Internal Tasks"
Cohesion: 0.11
Nodes (24): onSessionDisconnected(), recoverStuckTasks(), runInternalTask(), setStoreModule(), shutdownManagedAPI(), setBillingStore(), ClientRole, extensionQueue (+16 more)

### Community 19 - "Tab Group Management"
Cohesion: 0.12
Nodes (22): isAnySessionActive(), addTabToGroup(), ensureTabGroup(), initTabManager(), registerTabCleanupListener(), DELAYS, MOUSE, RETRIES (+14 more)

### Community 20 - "Captcha Solving"
Cohesion: 0.11
Nodes (20): bruteForceSolver(), solveCaptcha(), SOLVERS, LIMITS, handleEscalate(), handleGetInfo(), handleResizeWindow(), handleSolveCaptcha() (+12 more)

### Community 21 - "WebSocket Connection Layer"
Cohesion: 0.16
Nodes (11): ConnectionOptions, IncomingMessageType, MessageHandler, NativeMessage, OutgoingMessageType, ClientRole, WebSocketClient, WebSocketClientOptions (+3 more)

### Community 22 - "Type Definitions & Content Blocks"
Cohesion: 0.08
Nodes (24): CleanTurn, ComputerToolInput, ContentBlock, FileUploadToolInput, FindToolInput, FormInputToolInput, ImageBlock, LogEntry (+16 more)

### Community 23 - "API Auth & Task Step Building"
Cohesion: 0.12
Nodes (19): ALLOWED_ORIGINS, authenticate(), buildToolResultTaskSteps(), checkRateLimit(), countConcurrentTasks(), extractApiKey(), handleCreateTask(), handleRelayCreateTask() (+11 more)

### Community 24 - "DOM Field Label Resolution"
Cohesion: 0.14
Nodes (19): clearRefMetaForTab(), recordRefMeta(), FIELD_ROLES, FIELD_TAGS, fieldLabelSequence(), fingerprintForm(), fingerprintFromSequence(), sha1Hex() (+11 more)

### Community 25 - "Domain Skills Loader"
Cohesion: 0.16
Nodes (15): _domainSkills, getDomainSkills(), isAntiBotEnabled(), scaleCoordinates(), scaleCoordinatesLive(), ScreenshotContextManager, elementResolver, generateScreenshotId() (+7 more)

### Community 26 - "Claude API Proxy & Credentials"
Cohesion: 0.14
Nodes (17): buildCodexHeaders(), getFreshClaudeCredentials(), handleApiProxy(), isCodexUrl(), sendProxyStream(), ClientRole, clients, extensionQueue (+9 more)

### Community 27 - "Pairing Token Tests"
Cohesion: 0.24
Nodes (19): assert(), runAll(), setup(), testPairingTokenExpiry(), testPairingTokenLifecycle(), testSessionTokenValidation(), testSessionWorkspaceBinding(), testUsageAttribution() (+11 more)

### Community 28 - "Managed API Initialization"
Cohesion: 0.23
Nodes (17): initVertex(), handleRelayMessage(), setup(), initManagedAPI(), startManagedAPI(), assert(), connectedSessions, mockRelay (+9 more)

### Community 29 - "CDP Debugger & Screenshots"
Cohesion: 0.18
Nodes (16): handleMcpScreenshot(), enableNetworkTracking(), ensureDebugger(), isDebuggerAttached(), registerDebuggerListener(), sendDebuggerCommand(), checkFileExists(), getDownloadsFolder() (+8 more)

### Community 30 - "Learned Plan Persistence"
Cohesion: 0.31
Nodes (17): asPromise(), deletePlan(), getMostRecentPlanForDomain(), getPlanByFingerprint(), getRelevantPlansForDomain(), listAllPlans(), mergeMistakes(), mergeStepLists() (+9 more)

### Community 31 - "OAuth Token Exchange"
Cohesion: 0.20
Nodes (15): base64UrlEncode(), generateRandomString(), getAccessToken(), getAuthStatus(), importCLICredentials(), importCLIViaNativeHost(), importCLIViaRelay(), isAuthenticated() (+7 more)

### Community 33 - "Agent Loop Unit Tests"
Cohesion: 0.35
Nodes (15): assert(), runAll(), testAbortSignal(), testAtomicFileWrites(), testGracefulShutdown(), testHeartbeatExpiryAndRevocation(), testModelAttribution(), testOnSessionDisconnected() (+7 more)

### Community 34 - "API Key CRUD Tests"
Cohesion: 0.41
Nodes (15): assert(), main(), req(), testApiKeyCRUDPostgres(), testAuthEnforcement(), testBetterAuthSignupAndAccess(), testBillingFieldsPostgres(), testHealthNoAuth() (+7 more)

### Community 36 - "Conversation Debug Log"
Cohesion: 0.22
Nodes (15): analyzeTurns(), buildCleanTurns(), buildTurnsFromDebugLog(), clearLog(), filterDebugLog(), getLogStorageKey(), getTaskDebugLog(), initLogging() (+7 more)

### Community 37 - "MCP Architecture Documentation"
Cohesion: 0.19
Nodes (15): Extension MCP Bridge (mcp-bridge.js), MCP Server (Transport & Session Layer), MCP Browser Tools (browser_start/message/status/stop/screenshot), Native Host IPC (Legacy Transport), WebSocket Relay Server, Chrome Extension Service Worker, REST API / Managed Mode, HanziClient TypeScript SDK (+7 more)

### Community 38 - "Telemetry & Config Paths"
Cohesion: 0.20
Nodes (14): captureException(), CONFIG_DIR, CONFIG_PATH, __dirname, __filename, getAnonymousId(), initTelemetry(), isTelemetryEnabled() (+6 more)

### Community 39 - "MCP Task Handlers"
Cohesion: 0.23
Nodes (14): handleMcpSendMessage(), _handleMcpSendMessageInner(), handleMcpStartTask(), handleMcpStopTask(), persistMcpSessions(), recoverSessionTab(), resolvePendingPlan(), startMcpTaskInternal() (+6 more)

### Community 40 - "Task Usage Tracking"
Cohesion: 0.23
Nodes (14): createEmptyTaskUsage(), currentTaskUsage, formatSessionSummary(), getOrCreateTaskUsage(), getSessionStats(), getTaskScope(), getTaskUsage(), PRICING (+6 more)

### Community 41 - "Dashboard Dependencies"
Cohesion: 0.14
Nodes (13): dependencies, posthog-js, preact, @sentry/browser, devDependencies, @preact/preset-vite, vite, name (+5 more)

### Community 43 - "Task Start & Debugger Lifecycle"
Cohesion: 0.15
Nodes (10): conversationHasSuccessMarker(), startTask(), detachDebugger(), hideAgentIndicators(), indicatorManager, showAgentIndicators(), createAbortController(), getApiCallCount() (+2 more)

### Community 44 - "Context Compaction"
Cohesion: 0.31
Nodes (11): calculateContextTokens(), compactConversation(), compactIfNeeded(), emergencyCompact(), estimateTextTokens(), extractTextFromResponse(), preserveRecentContext(), prunePastReadPageResults() (+3 more)

### Community 45 - "Relay Connection Management"
Cohesion: 0.27
Nodes (12): clearManagedSession(), connectToRelay(), _doConnect(), setManagedSession(), dispatchProxyResponse(), dispatchRelayResponse(), failAllPending(), getRelaySocket() (+4 more)

### Community 46 - "TypeScript Compiler Config"
Cohesion: 0.15
Nodes (12): compilerOptions, declaration, esModuleInterop, module, moduleResolution, outDir, rootDir, skipLibCheck (+4 more)

### Community 48 - "DOM Selector & Value Classifier"
Cohesion: 0.24
Nodes (12): buildSelectorHint(), classifyValueKind(), _currentChunk(), _ensure(), flattenProfile(), getRecording(), isToday(), _recordings (+4 more)

### Community 49 - "Extension UI Indicators"
Cohesion: 0.24
Nodes (7): createGlowBorder(), createPoweredByBadge(), createStaticIndicator(), createStopButton(), injectStyles(), showGlowIndicator(), showStaticIndicator()

### Community 51 - "HTTP Request Helpers"
Cohesion: 0.41
Nodes (11): handleRequest(), parseBody(), rejectPublishable(), sendJson(), handleWebhook(), isBillingEnabled(), trackManagedEvent(), handleKeyAndBillingRoutes() (+3 more)

### Community 52 - "Auth Session Resolution"
Cohesion: 0.29
Nodes (10): createAuth(), getProvisionPool(), resolveSessionProfile(), resolveSessionToWorkspace(), getPairingPageHtml(), getSelfPairPageHtml(), handlePageRoutes(), MIME_TYPES (+2 more)

### Community 54 - "Conversation Checkpoint"
Cohesion: 0.38
Nodes (11): asPromise(), checkpointKey(), compactBlock(), compactMessages(), deleteCheckpoint(), getCheckpoint(), openDb(), pruneExpiredCheckpoints() (+3 more)

### Community 55 - "Live End-to-End Tests"
Cohesion: 0.38
Nodes (11): __dirname, findNativeHost(), log(), LOG_DIR, LOG_FILE, logSection(), runLiveTests(), sendToNativeHost() (+3 more)

### Community 56 - "SDK Session Types"
Cohesion: 0.35
Nodes (9): CreateSessionOptions, Question, SerializedSession, Session, SessionState, SessionStatus, TraceEntry, TransitionResult (+1 more)

### Community 57 - "Accessibility Tree Builder"
Cohesion: 0.47
Nodes (9): buildTree(), buildTreeInIframe(), getName(), getRole(), hasSemantic(), isInteractive(), isVisible(), processIframes() (+1 more)

### Community 58 - "Automation Scout & Post Scheduler"
Cohesion: 0.29
Nodes (9): buildPostPrompt(), buildScoutPrompt(), computeNextRun(), ParsedDraft, parseScoutAnswer(), runScoutTask(), tick(), Automation (+1 more)

### Community 59 - "Stripe Billing & Credits"
Cohesion: 0.24
Nodes (6): createCheckoutSession(), CREDIT_PACKS, initBilling(), loadCreditPacks(), log, LogContext

### Community 60 - "LLM Content Block Types"
Cohesion: 0.20
Nodes (9): CallLLMParams, ContentBlock, ContentBlockImage, ContentBlockText, ContentBlockToolResult, ContentBlockToolUse, LLMResponse, Message (+1 more)

### Community 61 - "Follow-up Message Tests"
Cohesion: 0.33
Nodes (9): connect(), handleMessage(), log(), pending, runTest(), send(), TIMEOUT_MS, timestamp() (+1 more)

### Community 62 - "Auth Mode Config"
Cohesion: 0.33
Nodes (5): AuthConfig, AuthMode, readAuthMode(), resolveAuth(), VALID_MODES

### Community 64 - "DOM Element Resolver"
Cohesion: 0.33
Nodes (4): createElementResolver(), _refMetaCache, elementResolver, handleFormInput()

### Community 65 - "Tool Result Formatting"
Cohesion: 0.33
Nodes (6): clearCapturedScreenshots(), enhanceErrorMessage(), formatToolResult(), getCapturedScreenshots(), getScreenshotScopeId(), removeCapturedScreenshots()

## Knowledge Gaps
- **285 isolated node(s):** `taskDebugLog`, `uiSessionState`, `capturedScreenshotsByScope`, `screenshotContexts`, `pendingPlanResolves` (+280 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bruteForceSolver()` connect `Captcha Solving` to `Agent Config & LLM Interface`?**
  _High betweenness centrality (0.280) - this node is a cross-community bridge._
- **Why does `sleep()` connect `Agent Config & LLM Interface` to `Captcha Solving`?**
  _High betweenness centrality (0.280) - this node is a cross-community bridge._
- **Why does `WebSocketClient` connect `WebSocket Connection Layer` to `MCP Message Payload Builders`, `Agent Config & LLM Interface`, `License & Usage Tracking`, `Session Recovery & Internal Tasks`, `API Auth & Task Step Building`, `Managed API Initialization`?**
  _High betweenness centrality (0.140) - this node is a cross-community bridge._
- **What connects `taskDebugLog`, `uiSessionState`, `capturedScreenshotsByScope` to the rest of the system?**
  _309 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Managed API Billing & Sessions` be split into smaller, more focused modules?**
  _Cohesion score 0.06656426011264721 - nodes in this community are weakly interconnected._
- **Should `Local Browser Tool Execution` be split into smaller, more focused modules?**
  _Cohesion score 0.07767722473604827 - nodes in this community are weakly interconnected._
- **Should `Analytics, Dashboard & Site Patterns` be split into smaller, more focused modules?**
  _Cohesion score 0.054693877551020405 - nodes in this community are weakly interconnected._