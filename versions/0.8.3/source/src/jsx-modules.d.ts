declare module "*markdown.jsx" {
  import type { ComponentType } from "react";

  export const Markdown: ComponentType<{ source: string; renderCitation?: (paperId: string | null, page: number, raw: string) => React.ReactNode }>;
}
