# Skills

Catalog of the Intent skills installed in this repository. Skills ship inside the
`node_modules` packages listed below and are loaded on demand as `SKILL.md` guidance;
they are never downloaded from elsewhere.

- Snapshot: `bunx --no-install --package @tanstack/intent intent list` (2026-10-03)
- Inventory: **12 intent-enabled packages, 51 skills**
- Regenerate this file when dependencies change.

## Skill Loading

Use the repository's installed Intent. If it is unavailable, report the missing
dependency instead of downloading a replacement. Before editing files for a
substantial task:

1. Run `bunx --no-install --package @tanstack/intent intent list` from the workspace
   root to see available local skills.
2. If a listed skill matches the task, run
   `bunx --no-install --package @tanstack/intent intent load <package>#<skill>`
   before changing files.
3. Use the loaded `SKILL.md` guidance while making the change.
4. Monorepos: when working across packages, run the skill check from the workspace
   root and prefer the local skill for the package being changed.
5. Multiple matches: prefer the most specific local skill for the package or concern
   you are changing; load additional skills only when the task spans multiple
   packages or concerns.

Load command used below: `intent load <ref>`, where `<ref>` is
`<package>#<skill>` (or `<package>#<skill>/<sub-skill>`).

## Quick picks for this repo

This is a TanStack Start + React app with TanStack AI, Drizzle, and an MCP server
route. Most tasks land in these skills:

| Task area | Skill ref |
| --- | --- |
| Chat / LLM features, tools, structured output | `@tanstack/ai#ai-core` (+ sub-skills) |
| Routes, params, loaders, navigation | `@tanstack/router-core#router-core` (+ sub-skills) |
| Server functions, middleware, API/server routes | `@tanstack/start-client-core#start-core` (+ sub-skills) |
| Start/React app setup, RSC | `@tanstack/react-start#react-start` |
| Route generation / code splitting plugin | `@tanstack/router-plugin#router-plugin` |
| `.env` files and secrets | `dotenv#dotenv` |

## Package catalog

### @tanstack/ai (0.64.0) - 12 skills

- **ai-core** `@tanstack/ai#ai-core` [core] - Entry point; routes to the sub-skills
  below and to companion-package skills. Use `chat()` not `streamText()`,
  `openaiText()` not `createOpenAI()`, `toServerSentEventsResponse()` not manual SSE,
  middleware hooks not `onEnd` callbacks.
  - **adapter-configuration** `@tanstack/ai#ai-core/adapter-configuration` [sub-skill] -
    Provider adapters (`openaiText`, `anthropicText`, `geminiText`, `ollamaText`,
    `grokText`, `groqText`, `openRouterText`, `bedrockText`, `byteplusText`,
    `openaiCompatible`), per-model `modelOptions`, `extendAdapter()`, `createModel()`.
    Env keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`,
    `XAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_HOST`,
    `BEDROCK_API_KEY`. BytePlus needs TWO keys: `ARK_API_KEY` + `BYTEPLUS_VOICE_API_KEY`.
  - **ag-ui-protocol** `@tanstack/ai#ai-core/ag-ui-protocol` [sub-skill] - Server-side
    AG-UI streaming: `StreamChunk` event types, `toServerSentEventsStream()` (SSE),
    `toHttpStream()` (NDJSON).
  - **chat-experience** `@tanstack/ai#ai-core/chat-experience` [sub-skill] - End-to-end
    chat: `chat()` + `toServerSentEventsResponse()` endpoint, `useChat` hook,
    `UIMessage` parts, multimodal content, thinking/reasoning display, streaming
    states and connection adapters. NOT Vercel AI SDK.
  - **client-persistence** `@tanstack/ai#ai-core/client-persistence` [sub-skill] -
    Browser chat persistence (`localStoragePersistence`,
    `sessionStoragePersistence`, `indexedDBPersistence`), client- vs
    server-authoritative (`persistence: true`),
    reload restore, pending interrupts, mid-stream rejoin. Also generation hooks
    (`useGenerateImage` etc.), server-driven only.
  - **custom-backend-integration** `@tanstack/ai#ai-core/custom-backend-integration`
    [composition] - Connect `useChat` to non-TanStack-AI backends via
    `ConnectConnectionAdapter` / `SubscribeConnectionAdapter`, custom
    `fetchServerSentEvents()` / `fetchHttpStream()` with auth. Import from the
    framework package, not `@tanstack/ai-client`.
  - **debug-logging** `@tanstack/ai#ai-core/debug-logging` [sub-skill] -
    `debug: true | false | DebugConfig` on `chat()`, `summarize()`, `generateImage()`,
    `generateSpeech()`, `generateTranscription()`, `generateVideo()`; categories
    (request, provider, output, middleware, tools, agentLoop, config, errors);
    `debug: { logger }` pipes into pino/winston.
  - **locks** `@tanstack/ai#ai-core/locks` [sub-skill] - `LockStore`,
    `InMemoryLockStore`, `LocksCapability`, `withLocks` for multi-instance
    coordination. Ships in `@tanstack/ai`; NOT for storing messages/runs
    (use `withPersistence`).
  - **media-generation** `@tanstack/ai#ai-core/media-generation` [sub-skill] -
    `generateImage()`, `generateAudio()`, `generateVideo()`, `generateSpeech()`,
    `generateTranscription()`, `generateVoice()` with activity-specific adapters and
    React hooks (`useGenerateImage`, `useGenerateAudio`, `useGenerateSpeech`,
    `useTranscription`, `useGenerateVideo`).
  - **middleware** `@tanstack/ai#ai-core/middleware` [sub-skill] - Chat lifecycle
    hooks `onConfig`, `onStart`, `onChunk`, `onBeforeToolCall`, `onAfterToolCall`,
    `onUsage`, `onFinish`, `onAbort`, `onError`; middleware array in `chat()`,
    left-to-right. NOT `onEnd`/`onFinish` callbacks on `chat()`.
  - **structured-outputs** `@tanstack/ai#ai-core/structured-outputs` [sub-skill] -
    `outputSchema` on `chat()` / `useChat()` with Zod, ArkType, or Valibot; provider
    strategies are transparent (never configure at provider level); `stream: true`
    for incremental deltas + `structured-output.complete`;
    `convertSchemaToJsonSchema()`.
  - **tool-calling** `@tanstack/ai#ai-core/tool-calling` [sub-skill] - Isomorphic
    `toolDefinition()` with Zod schemas, `.server()` / `.client()` implementations,
    passing tools to `chat()` and `useChat`/`clientTools`, approval flows
    (`needsApproval`, `resolveInterrupt`), `defineInterrupt()`, lazy discovery
    (`lazy: true`), rendering `ToolCallPart` / `ToolResultPart`.

### @tanstack/devtools (0.15.0) - 4 skills

- **devtools-app-setup** `@tanstack/devtools#devtools-app-setup` [core] - Install
  TanStack Devtools, pick a framework adapter, register plugins via `plugins`, shell
  config (position, hotkeys, theme, `hideUntilHover`, `requireUrlFlag`,
  `eventBusConfig`), `TanStackDevtools`, `defaultOpen`, localStorage persistence.
- **devtools-marketplace** `@tanstack/devtools#devtools-marketplace` [lifecycle] -
  Publish a plugin to npm and submit to the Marketplace: `PluginMetadata` registry
  format, `plugin-registry.ts`, `pluginImport`, `requires`, framework tagging.
- **devtools-plugin-panel** `@tanstack/devtools#devtools-plugin-panel` [core] - Build
  panels that display emitted event data: `EventClient.on()`, theming,
  `@tanstack/devtools-ui` components, plugin registration (name, render, id,
  defaultOpen), lifecycle (mount, activate, destroy), max 3 active plugins.
- **devtools-production** `@tanstack/devtools#devtools-production` [lifecycle] -
  Production vs development: `removeDevtoolsOnBuild`, devDependency, conditional
  imports, NoOp plugin variants for tree-shaking, non-Vite exclusion.

### @tanstack/devtools-event-client (0.5.0) - 3 skills

- **devtools-bidirectional** `@tanstack/devtools-event-client#devtools-bidirectional`
  [core] - Two-way patterns between panel and app, time-travel debugging with
  snapshots and revert, `structuredClone` for snapshot safety, distinct event
  suffixes for observation vs commands, serializable payloads only.
- **devtools-event-client** `@tanstack/devtools-event-client#devtools-event-client`
  [core] - Typed `EventClient`, typed event maps, `pluginId` auto-prepend
  namespacing, `emit()`/`on()`/`onAll()`/`onAllPluginEvents()`, connection lifecycle
  (5 retries, 300ms), event queuing, SSR fallbacks, singleton pattern. Unique
  `pluginId` required to avoid event collisions.
- **devtools-instrumentation**
  `@tanstack/devtools-event-client#devtools-instrumentation` [core] - Add strategic
  event emissions at middleware boundaries, state transitions, and lifecycle hooks.
  Consolidate events (1 not 15), debounce high-frequency updates, DRY shared payload
  fields, guard `emit()` for production, transparent server/client bridging.

### @tanstack/devtools-vite (0.8.5) - 1 skill

- **devtools-vite-plugin** `@tanstack/devtools-vite#devtools-vite-plugin` [core] -
  Source inspection (`data-tsd-source`, `inspectHotkey`, ignore patterns), console
  piping (both directions, levels), server event bus (port, host, HTTPS), production
  stripping (`removeDevtoolsOnBuild`), editor integration. Must be the FIRST plugin
  in the Vite config. Vite ^6 || ^7 only.

### @tanstack/markdown (0.0.13) - 6 skills

- **custom-extensions** `@tanstack/markdown#custom-extensions` [core] - Implement
  `MarkdownExtension` block parsers, inline and document transforms, HTML hooks, and
  portable `ComponentNode` output across HTML, React, and Octane.
- **docs-features** `@tanstack/markdown#docs-features` [core] - Documentation
  metadata with `docsMarkdownExtensions`, GitHub-style callouts, heading collection,
  heading/file/package-manager/bundler tabs, framework panels, code-fence metadata.
- **octane-rendering** `@tanstack/markdown#octane-rendering` [framework] - Render
  with `@tanstack/markdown/octane`: `Markdown`, `renderMarkdownOctane`,
  `ComponentBody` replacements, TSRX, octane/server static SSR, renderer parity.
- **production-pipelines** `@tanstack/markdown#production-pipelines` [lifecycle] -
  Production Markdown pipelines: explicit trust boundaries, external syntax
  highlighting, parse-ahead caching, compatibility checks, deterministic output,
  bundle budgets. Load before shipping blogs/docs/untrusted-content rendering.
- **react-rendering** `@tanstack/markdown#react-rendering` [framework] - Render with
  `@tanstack/markdown/react`: `Markdown`, `renderMarkdownReact`, component
  replacements, emitted-tag mappings, pre-parsed documents, React static SSR.
- **render-markdown** `@tanstack/markdown#render-markdown` [core] - Parse with
  `parseMarkdown` / `parseInline`, render HTML with `renderHtml`, `renderDocument`,
  `renderBlock`, `renderInline`; frontmatter, heading IDs, serializable
  `MarkdownDocument` AST; references, footnotes, lists, tables.

### @tanstack/react-start (1.168.60) - 3 skills

- **react-start** `@tanstack/react-start#react-start` [framework] - React bindings for
  TanStack Start: `createStart`, `StartClient`, `StartServer`, React-specific
  imports, re-exports from `@tanstack/react-router`, full project setup,
  `useServerFn`.
  - **server-components** `@tanstack/react-start#react-start/server-components`
    [sub-skill] - React Server Components in React 19: `renderServerComponent`,
    `createCompositeComponent`, `CompositeComponent`, `renderToReadableStream`,
    `createFromReadableStream` / `createFromFetch`, React Flight streams, RSC
    caching, `router.invalidate`, `structuralSharing: false`, selective SSR. Not for
    generic SSR or non-TanStack RSC frameworks.
  - **lifecycle/migrate-from-nextjs**
    `@tanstack/react-start#lifecycle/migrate-from-nextjs` [lifecycle] - Migrate from
    Next.js App Router: route definitions, API mapping, Server Actions to server
    functions, middleware, data fetching.

### @tanstack/router-core (1.171.34) - 10 skills

- **router-core** `@tanstack/router-core#router-core` [core] - Framework-agnostic
  core: route trees, `createRouter`, `createRoute`, `createRootRoute`,
  `createRootRouteWithContext`, `addChildren`, `Register` type declaration, route
  matching and sorting, file naming conventions. Entry point for all router skills.
  - **auth-and-guards** `@tanstack/router-core#router-core/auth-and-guards`
    [sub-skill] - Route protection with `beforeLoad`, `redirect()` /
    `throw redirect()`, `isRedirect`, `_authenticated` layout routes, non-redirect
    auth, RBAC, Auth0/Clerk/Supabase integration, router context for auth state.
  - **code-splitting** `@tanstack/router-core#router-core/code-splitting`
    [sub-skill] - `autoCodeSplitting`, `.lazy.tsx` convention,
    `createLazyFileRoute`, `createLazyRoute`, `lazyRouteComponent`, `getRouteApi`,
    `codeSplitGroupings`, `splitBehavior`, critical vs non-critical properties.
  - **data-loading** `@tanstack/router-core#router-core/data-loading` [sub-skill] -
    `loader` option, `loaderDeps` cache keys, SWR caching (`staleTime`, `gcTime`,
    `defaultPreloadStaleTime`), `pendingComponent`/`pendingMs`/`pendingMinMs`,
    `errorComponent`/`onError`/`onCatch`, `beforeLoad`, `createRootRouteWithContext`
    DI, `router.invalidate`, `Await`, deferred data.
  - **navigation** `@tanstack/router-core#router-core/navigation` [sub-skill] -
    `Link`, `useNavigate`, `Navigate`, `router.navigate`, `ToOptions`/
    `NavigateOptions`/`LinkOptions`, relative `from`/`to`,
    `activeOptions`/`activeProps`, preloading (intent/viewport/render),
    `preloadDelay`, navigation blocking (`useBlocker`, `Block`), `createLink`,
    `linkOptions`, scroll restoration, `MatchRoute`.
  - **not-found-and-errors** `@tanstack/router-core#router-core/not-found-and-errors`
    [sub-skill] - `notFound()`, `notFoundComponent`, `defaultNotFoundComponent`,
    `notFoundMode` (fuzzy/root), `errorComponent`, `CatchBoundary`, `CatchNotFound`,
    `isNotFound`, route masking (`mask`, `createRouteMask`, `unmaskOnReload`).
  - **path-params** `@tanstack/router-core#router-core/path-params` [sub-skill] -
    Dynamic `$paramName` segments, splat routes (`$` / `_splat`), optional params
    (`{-$paramName}`), prefix/suffix patterns (`{$param}.ext`), `useParams`,
    `params.parse`/`stringify`, `pathParamsAllowedCharacters`, i18n locale patterns.
  - **search-params** `@tanstack/router-core#router-core/search-params` [sub-skill] -
    `validateSearch` with Zod/Valibot/ArkType, `fallback()`, search middlewares
    (`retainSearchParams`, `stripSearchParams`), custom `parseSearch`/
    `stringifySearch`, search param inheritance, `loaderDeps`, reading/writing
    search params.
  - **ssr** `@tanstack/router-core#router-core/ssr` [sub-skill] - Non-streaming and
    streaming SSR, `RouterClient`/`RouterServer`,
    `renderRouterToString`/`renderRouterToStream`, `createRequestHandler`,
    `defaultRenderHandler`/`defaultStreamHandler`, `HeadContent`/`Scripts`, `head`
    route option, `ScriptOnce`, loader dehydration/hydration, memory history on
    server, data serialization.
  - **type-safety** `@tanstack/router-core#router-core/type-safety` [sub-skill] -
    Full type inference (never cast, never annotate inferred values), `Register`
    module declaration, `from` narrowing, `strict: false` for shared components,
    `getRouteApi`, `addChildren` object syntax for TS perf, `LinkProps` /
    `ValidateLinkOptions`, `as const satisfies`.

### @tanstack/router-plugin (1.168.42) - 1 skill

- **router-plugin** `@tanstack/router-plugin#router-plugin` [core] - Bundler plugin
  for route generation and automatic code splitting. Vite, Webpack, Rspack, esbuild.
  Configures `autoCodeSplitting`, `routesDirectory`, target framework, code split
  groupings.

### @tanstack/start-client-core (1.170.34) - 7 skills

- **start-core** `@tanstack/start-client-core#start-core` [core] - Core overview:
  `tanstackStart()` Vite plugin, `getRouter()` factory, root route document shell
  (`HeadContent`, `Scripts`, `Outlet`), client/server entry points,
  `routeTree.gen.ts`, tsconfig. Entry point for all Start skills.
  - **auth-server-primitives**
    `@tanstack/start-client-core#start-core/auth-server-primitives` [sub-skill] -
    Session cookies (HttpOnly, Secure, SameSite, `__Host-` prefix), session
    read/issue/destroy via `createServerFn` + middleware, OAuth authorization-code
    with state and PKCE, password-reset enumeration defense, CSRF for non-GET RPCs,
    rate limiting, session rotation on privilege change.
  - **deployment** `@tanstack/start-client-core#start-core/deployment` [sub-skill] -
    Deploy to Cloudflare Workers, Netlify, Vercel, Node.js/Docker, Bun, Railway.
    Selective SSR (`ssr` per route), SPA mode, static prerendering, ISR with
    `Cache-Control`, SEO/head management.
  - **execution-model** `@tanstack/start-client-core#start-core/execution-model`
    [sub-skill] - Isomorphic-by-default; `createServerFn`, `createServerOnlyFn`,
    `createClientOnlyFn`, `createIsomorphicFn`, `ClientOnly`, `useHydrated`, import
    protection, dead code elimination, env var safety (`VITE_` prefix,
    `process.env`).
  - **middleware** `@tanstack/start-client-core#start-core/middleware` [sub-skill] -
    `createMiddleware`, request middleware (`.server` only), server function
    middleware (`.client` + `.server`), `next({ context })`, `sendContext`, global
    middleware via `createStart` in `src/start.ts`, middleware factories, method
    order enforcement, fetch override precedence.
  - **server-functions** `@tanstack/start-client-core#start-core/server-functions`
    [sub-skill] - `createServerFn` (GET/POST), validator (Zod or function),
    `useServerFn`, server context utilities (`getRequest`, `getRequestHeader`,
    `setResponseHeader`, `setResponseStatus`), error handling (throw, redirect,
    `notFound`), streaming, FormData, file organization (`.functions.ts`,
    `.server.ts`).
  - **server-routes** `@tanstack/start-client-core#start-core/server-routes`
    [sub-skill] - Server API endpoints via `server` on `createFileRoute`, HTTP
    method handlers (GET, POST, PUT, DELETE), `createHandlers` for per-handler
    middleware, handler context (`request`, `params`, `context`), request body
    parsing, response helpers, API route file naming.

### @tanstack/start-server-core (1.169.39) - 1 skill

- **start-server-core** `@tanstack/start-server-core#start-server-core` [core] -
  Server-side runtime: `createStartHandler`, request/response utilities (`getRequest`,
  `setResponseHeader`, `setCookie`, `getCookie`, `useSession`), three-phase request
  handling, AsyncLocalStorage context.

### @tanstack/virtual-file-routes (1.162.0) - 1 skill

- **virtual-file-routes** `@tanstack/virtual-file-routes#virtual-file-routes` [core] -
  Programmatic route trees instead of filesystem conventions: `rootRoute`, `index`,
  `route`, `layout`, `physical`, `defineVirtualSubtreeConfig`; used with the router
  plugin's `virtualRouteConfig` option.

### dotenv (17.4.2) - 2 skills

- **dotenv** `dotenv#dotenv` - Load environment variables from a `.env` file into
  `process.env`. Always load when `.env` is mentioned; contains critical gotchas
  (encrypted keys, variable expansion, command substitution).
- **dotenvx** `dotenv#dotenvx` - Run commands with environment variables, manage
  multiple `.env` files, expand variables, and encrypt env files for safe commits
  and CI/CD.

## Notices

- **Version conflict**: `@tanstack/devtools-event-client` is installed twice -
  0.5.0 at `node_modules/@tanstack/devtools-event-client` (used) and 0.4.4 nested
  under `node_modules/@tanstack/ai-event-client/node_modules/`. Intent resolves to
  0.5.0.
- **Skill sources**: all sources allowed (`intent.skills: ["*"]` in `package.json`) -
  unvetted skills may be surfaced into agent guidance.
