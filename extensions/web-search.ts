import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

interface SearchResult {
  title: string;
  url: string;
}

interface QueryResultData {
  query: string;
  answer: string;
  results: SearchResult[];
  error: string | null;
  provider?: string;
}

interface FetchedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

interface WebAccessModules {
  register: (pi: ExtensionAPI) => void;
  search: (
    query: string,
    options: {
      numResults: number;
      domainFilter?: string[];
      signal?: AbortSignal;
      extensionContext: ExtensionContext;
    },
  ) => Promise<{ answer: string; results: SearchResult[]; provider: string }>;
  fetchAllContent: (urls: string[], signal?: AbortSignal) => Promise<FetchedContent[]>;
  generateId: () => string;
  storeResult: (id: string, data: object) => void;
  storeFetchedContentResult: (id: string, data: object) => object;
}

let webAccessModules: Promise<WebAccessModules> | null = null;
function getWebAccess(): Promise<WebAccessModules> {
  if (!webAccessModules) {
    // Jiti mis-binds transitive Node built-in imports when these TypeScript modules load concurrently.
    webAccessModules = (async () => {
      const indexModule = await import(new URL("./node_modules/pi-web-access/index.ts", import.meta.url).href);
      const searchModule = await import(new URL("./node_modules/pi-web-access/gemini-search.ts", import.meta.url).href);
      const extractModule = await import(new URL("./node_modules/pi-web-access/extract.ts", import.meta.url).href);
      const storageModule = await import(new URL("./node_modules/pi-web-access/storage.ts", import.meta.url).href);
      return {
        register: indexModule.default,
        search: searchModule.search,
        fetchAllContent: extractModule.fetchAllContent,
        generateId: storageModule.generateId,
        storeResult: storageModule.storeResult,
        storeFetchedContentResult: storageModule.storeFetchedContentResult,
      };
    })();
  }
  return webAccessModules;
}

const SearchParams = Type.Object({
  queries: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 4,
    description: "Search queries. Use multiple queries for research.",
  }),
  domains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Limit results to these domains.",
    }),
  ),
  raw: Type.Optional(
    Type.Boolean({
      description: "Return sources without the search answer.",
    }),
  ),
});

type SearchInput = Static<typeof SearchParams>;

function formatResults(queryData: QueryResultData[], raw: boolean, fetchId?: string): string {
  const sections = queryData.map(({ answer, query, results }) => {
    const answerSection = raw || !answer ? "" : `${answer}\n\n---\n\n`;
    const sources =
      results.length === 0
        ? "No sources returned."
        : results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}`).join("\n\n");
    return `## ${query}\n\n${answerSection}Sources:\n${sources}`;
  });
  if (fetchId) sections.push(`Full page content is available through get_search_content with responseId ${fetchId}.`);
  return sections.join("\n\n");
}

export default async function webSearch(pi: ExtensionAPI) {
  // Load pi-web-access in the background; don't block startup on it.
  // Register its extra tools (source_check, fetch_content, etc.) just before the first agent turn.
  let webAccessRegistered = false;
  pi.on("session_start", async () => {
    if (webAccessRegistered) return;
    webAccessRegistered = true;
    const webAccess = await getWebAccess();
    webAccess.register(pi);
  });

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: "Search the web and return cited results.",
    promptSnippet: "Search the web for current or external information.",
    parameters: SearchParams,
    async execute(_toolCallId, params: SearchInput, signal, _onUpdate, ctx) {
      const webAccess = await getWebAccess();
      const queries = params.queries.map((query) => query.trim()).filter(Boolean);
      if (queries.length === 0) throw new Error("Provide at least one non-empty query.");
      const responses = await Promise.all(
        queries.map(async (query) => {
          try {
            const response = await webAccess.search(query, {
              numResults: 10,
              ...(params.domains ? { domainFilter: params.domains } : {}),
              ...(signal ? { signal } : {}),
              extensionContext: ctx,
            });
            return {
              query,
              answer: response.answer,
              results: response.results,
              error: null,
              provider: response.provider,
            };
          } catch (error) {
            if (signal?.aborted) throw error;
            return { query, answer: "", results: [], error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      const searchId = webAccess.generateId();
      const searchData = { id: searchId, type: "search", timestamp: Date.now(), queries: responses };
      webAccess.storeResult(searchId, searchData);
      pi.appendEntry("web-search-results", searchData);

      const urls = responses.flatMap((response) => response.results.map((result) => result.url));
      const fetched = urls.length === 0 ? [] : await webAccess.fetchAllContent([...new Set(urls)], signal);
      const fetchId = fetched.length === 0 ? undefined : webAccess.generateId();
      if (fetchId) {
        const fetchData = webAccess.storeFetchedContentResult(fetchId, {
          id: fetchId,
          type: "fetch",
          timestamp: Date.now(),
          urls: fetched,
        });
        pi.appendEntry("web-search-results", fetchData);
      }

      return {
        content: [{ type: "text", text: formatResults(responses, params.raw ?? false, fetchId) }],
        details: { responseId: searchId, ...(fetchId ? { fetchId } : {}) },
      };
    },
  });
}
