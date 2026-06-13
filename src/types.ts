export interface ParseResult {
  language: string;
  metrics: {
    totalLines: number;
    codeLines: number;
    commentLines: number;
    blankLines: number;
    totalBytes: number;
    nodeCount: number;
    errorCount: number;
    maxDepth: number;
  };
  structure: Array<{
    kind: string;
    name: string;
    startLine: number;
    endLine: number;
    docComment?: string;
    signature?: string;
  }>;
  imports: Array<{
    source: string;
    items: string[];
    isWildcard: boolean;
  }>;
  exports: Array<{
    name: string;
    kind: string;
  }>;
}
