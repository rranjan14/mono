/* oxlint-disable no-console */
/* oxlint-disable @typescript-eslint/no-explicit-any */
import {useCallback, useEffect, useState} from 'react';
import {Panel, PanelGroup, PanelResizeHandle} from 'react-resizable-panels';
import * as ts from 'typescript';
import './App.css';
import {CredentialsModal} from './components/credentials-modal.tsx';
import {QueryEditor} from './components/query-editor.tsx';
import {QueryHistory} from './components/query-history.tsx';
import {ResultsViewer} from './components/results-viewer.tsx';
import {ServerStatusModal} from './components/server-status-modal.tsx';
import {VerticalNav} from './components/vertical-nav.tsx';
import {
  type QueryHistoryItem,
  type RemoteRunResult,
  type Result,
} from './types.ts';
// oxlint-disable-next-line no-restricted-imports
import * as zero from '../../../packages/zero-client/src/mod.ts';
import {mapAST} from '../../../packages/zero-protocol/src/ast.ts';
import {clientToServer} from '../../../packages/zero-schema/src/name-mapper.ts';
import {delegateSymbol} from '../../../packages/zql/src/query/query.ts';
import {VizDelegate} from './query-delegate.ts';

type AnyQuery = zero.Query<any, any, any>;
const DEFAULT_QUERY = `const {
  createBuilder,
  createSchema,
  table,
  number,
  string,
  boolean,
  enumeration,
  relationships,
} = zero;

// === Schema Declaration ===
const user = table('user')
  .columns({
    id: string(),
    login: string(),
    name: string().optional(),
  })
    .primaryKey('id');

const issue = table('issue')
  .columns({
    id: string(),
    shortID: number().optional(),
    title: string(),
    open: boolean(),
    modified: number(),
    created: number(),
    creatorID: string(),
    assigneeID: string().optional(),
    description: string(),
    visibility: enumeration<'internal' | 'public'>(),
  })
  .primaryKey('id');

const userRelationships = relationships(user, ({many}) => ({
  createdIssues: many({
    sourceField: ['id'],
    destField: ['creatorID'],
    destSchema: issue,
  }),
  assignedIssues: many({
    sourceField: ['id'],
    destField: ['assigneeID'],
    destSchema: issue,
  }),
}));

const builder = createBuilder(createSchema({
  tables: [user, issue],
  relationships: [userRelationships]
}));

//: Get user and their assigned issues
run(
  builder.user
    .related('assignedIssues', q => q.orderBy('modified', 'desc'))
)`;

function App() {
  const [queryCode, setQueryCode] = useState(() => {
    const savedQuery = localStorage.getItem('zql-query');
    if (savedQuery) {
      return savedQuery;
    }
    return DEFAULT_QUERY;
  });
  const [result, setResult] = useState<Result | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [auth, setAuth] = useState<
    {serverUrl: string; password: string} | undefined
  >(() => {
    const savedAuth = localStorage.getItem('zql-auth');
    return savedAuth ? JSON.parse(savedAuth) : undefined;
  });
  const [isCredentialsModalOpen, setIsCredentialsModalOpen] = useState(false);
  const [isHistoryVisible, setIsHistoryVisible] = useState(true);
  const [isServerStatusModalOpen, setIsServerStatusModalOpen] = useState(false);
  const [history, setHistory] = useState<QueryHistoryItem[]>(() => {
    const savedHistory = localStorage.getItem('zql-history');
    if (savedHistory) {
      const parsed = JSON.parse(savedHistory);
      return parsed.map((item: any) => ({
        ...item,
        timestamp: new Date(item.timestamp),
      }));
    }

    return [];
  });

  useEffect(() => {
    localStorage.setItem('zql-query', queryCode);
  }, [queryCode]);

  useEffect(() => {
    localStorage.setItem('zql-history', JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (auth) {
      localStorage.setItem('zql-auth', JSON.stringify(auth));
    } else {
      localStorage.removeItem('zql-auth');
    }
  }, [auth]);

  const executeQuery = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    setResult(undefined);

    // Extract text after //:  comment for history preview
    const extractHistoryPreview = (code: string): string => {
      const lines = code.split('\n');

      // Find the line with //: comment
      let previewStartIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();
        if (trimmedLine.startsWith('//:')) {
          previewStartIndex = i;
          break;
        }
      }

      if (previewStartIndex === -1) {
        return ''; // No //: comment found, fallback to full code
      }

      const previewLines = lines.slice(previewStartIndex).join('\n');

      // Combine title and preview
      return previewLines;
    };

    let capturedQuery: AnyQuery | undefined;
    let capturedSchema: zero.Schema | undefined;
    const historyPreviewText = extractHistoryPreview(queryCode);

    const customGlobals = {
      zero: {
        ...zero,
        createSchema(args: Parameters<typeof zero.createSchema>[0]) {
          capturedSchema = zero.createSchema(args);
          return capturedSchema;
        },
      },
      run: (query: AnyQuery) => {
        capturedQuery = query;
        return query; // Return the query for potential chaining
      },
    };

    function executeCode(code: string) {
      // Transpile TypeScript to JavaScript
      const result = ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          strict: false,
          esModuleInterop: true,
          skipLibCheck: true,
          allowSyntheticDefaultImports: true,
        },
      });

      const func = new Function(
        ...Object.keys(customGlobals),
        result.outputText,
      );
      return func(...Object.values(customGlobals));
    }

    try {
      executeCode(queryCode);
      if (capturedSchema === undefined) {
        throw new Error('Failed to capture the schema definition');
      }
      if (capturedQuery === undefined) {
        throw new Error('Failed to capture the query definition');
      }
      const vizDelegate = new VizDelegate(capturedSchema);
      capturedQuery = capturedQuery[delegateSymbol](vizDelegate);
      (await capturedQuery.run()) as any;
      const graph = vizDelegate.getGraph();
      const mapper = clientToServer(capturedSchema.tables);

      let remoteRunResult: RemoteRunResult | undefined;
      try {
        if (auth && auth.serverUrl) {
          console.log('Using server URL:', auth.serverUrl);
          const credentials = btoa(`:${auth.password}`);
          const response = await fetch(`${auth.serverUrl}/analyze-queryz`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Basic ${credentials}`,
            },
            body: JSON.stringify({
              ast: mapAST(capturedQuery.ast, mapper),
            }),
          });

          remoteRunResult = await response.json();
        } else {
          console.warn(
            'No auth credentials set or server URL missing, will not run the query server side or analyze it server side',
            auth,
          );
        }
      } catch (e) {
        console.error('Error calling server:', e);
      }

      setResult({
        ast: capturedQuery?.ast,
        graph,
        remoteRunResult,
      });

      // Check if the current query code is the same as the previous entry
      setHistory(prev => {
        if (prev.length > 0 && prev[0].fullCode === queryCode) {
          // Update the timestamp of the most recent entry
          const updatedHistory = [...prev];
          updatedHistory[0] = {
            ...updatedHistory[0],
            timestamp: new Date(),
            result: capturedQuery, // Update result too
          };
          return updatedHistory;
        }
        // Add new history entry
        const historyItem: QueryHistoryItem = {
          id: Date.now().toString(),
          query: historyPreviewText || queryCode,
          fullCode: queryCode,
          timestamp: new Date(),
          result: capturedQuery,
        };
        return [historyItem, ...prev].slice(0, 150);
      });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown error occurred';
      setError(errorMessage);

      // Check if the current query code is the same as the previous entry
      setHistory(prev => {
        if (prev.length > 0 && prev[0].fullCode === queryCode) {
          // Update the timestamp and error of the most recent entry
          const updatedHistory = [...prev];
          updatedHistory[0] = {
            ...updatedHistory[0],
            timestamp: new Date(),
            error: errorMessage,
            result: undefined, // Clear result since there's an error
          };
          return updatedHistory;
        }
        // Add new history entry
        const historyItem: QueryHistoryItem = {
          id: Date.now().toString(),
          query: historyPreviewText || queryCode,
          fullCode: queryCode,
          timestamp: new Date(),
          error: errorMessage,
        };
        return [historyItem, ...prev].slice(0, 150);
      });
    } finally {
      setIsLoading(false);
    }
  }, [queryCode, auth]);

  const handleSelectHistoryQuery = useCallback(
    (historyItem: QueryHistoryItem) => {
      // Use fullCode if available (the complete executable code), otherwise use the query preview
      setQueryCode(historyItem.fullCode || historyItem.query);
    },
    [],
  );

  const handleClearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  const handleOpenCredentials = useCallback(() => {
    setIsCredentialsModalOpen(true);
  }, []);

  const handleSaveCredentials = useCallback(
    (serverUrl: string, password: string) => {
      setAuth({serverUrl, password});
    },
    [],
  );

  const handleCloseCredentials = useCallback(() => {
    setIsCredentialsModalOpen(false);
  }, []);

  const handleToggleHistory = useCallback(() => {
    setIsHistoryVisible(prev => !prev);
  }, []);

  const handleShowServerStatus = useCallback(() => {
    setIsServerStatusModalOpen(true);
  }, []);

  const handleCloseServerStatus = useCallback(() => {
    setIsServerStatusModalOpen(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        void executeQuery();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [executeQuery]);

  return (
    <div className="app">
      <div className="app-body">
        <VerticalNav
          onShowHistory={handleToggleHistory}
          onOpenCredentials={handleOpenCredentials}
          onShowServerStatus={handleShowServerStatus}
          hasCredentials={!!auth}
          isHistoryVisible={isHistoryVisible}
        />
        <div className="main-content">
          <PanelGroup direction="horizontal">
            {isHistoryVisible && (
              <>
                <Panel defaultSize={20} minSize={15}>
                  <PanelGroup direction="vertical">
                    <Panel defaultSize={100} minSize={30}>
                      <QueryHistory
                        history={history}
                        onSelectQuery={handleSelectHistoryQuery}
                        onClearHistory={handleClearHistory}
                      />
                    </Panel>
                  </PanelGroup>
                </Panel>
                <PanelResizeHandle className="resize-handle-vertical" />
              </>
            )}

            <Panel defaultSize={isHistoryVisible ? 40 : 50} minSize={30}>
              <QueryEditor
                value={queryCode}
                onChange={setQueryCode}
                onExecute={executeQuery}
              />
            </Panel>

            <PanelResizeHandle className="resize-handle-vertical" />

            <Panel defaultSize={isHistoryVisible ? 40 : 50} minSize={30}>
              <ResultsViewer
                result={result}
                error={error}
                isLoading={isLoading}
              />
            </Panel>
          </PanelGroup>
        </div>
      </div>
      <CredentialsModal
        isOpen={isCredentialsModalOpen}
        onClose={handleCloseCredentials}
        onSave={handleSaveCredentials}
        initialServerUrl={auth?.serverUrl || ''}
        initialPassword={auth?.password || ''}
      />
      <ServerStatusModal
        isOpen={isServerStatusModalOpen}
        onClose={handleCloseServerStatus}
        hasCredentials={!!auth}
        serverUrl={auth?.serverUrl}
      />
    </div>
  );
}

export default App;
