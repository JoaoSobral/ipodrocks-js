import ReactMarkdown from "react-markdown";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * Renders markdown content with chat-friendly styling (bold, italic, code,
 * lists, headings, blockquotes, links).
 */
export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  return (
    <div className={`markdown-chat text-sm ${className}`}>
      <ReactMarkdown
        components={{
          p: ({ children }) => (
            <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic text-muted-foreground">
              {children}
            </em>
          ),
          h1: ({ children }) => (
            <h1 className="text-base font-semibold mt-3 mb-1.5 first:mt-0 text-foreground">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-semibold mt-3 mb-1 first:mt-0 text-foreground">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-medium mt-2 mb-1 text-muted-foreground">
              {children}
            </h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary/40 pl-3 my-2 text-muted-foreground">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => {
            const safeHref =
              href && /^https?:\/\//i.test(href) ? href : "#";
            return (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:text-primary/80 underline"
              >
                {children}
              </a>
            );
          },
          code: ({ className: langClass, children, ...props }) => {
            const isBlock = langClass?.startsWith("language-");
            const codeBg = "bg-muted/50";
            return isBlock ? (
              <code
                className={`block p-2 rounded text-xs overflow-x-auto my-1.5 ${codeBg}`}
                {...props}
              >
                {children}
              </code>
            ) : (
              <code
                className={`px-1.5 py-0.5 rounded text-[0.9em] font-mono ${codeBg}`}
                {...props}
              >
                {children}
              </code>
            );
          },
          ul: ({ children }) => (
            <ul className="list-disc list-outside ml-4 my-2 space-y-0.5">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-outside ml-4 my-2 space-y-0.5">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed pl-0.5">{children}</li>
          ),
          hr: () => (
            <hr className="border-border my-2" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
