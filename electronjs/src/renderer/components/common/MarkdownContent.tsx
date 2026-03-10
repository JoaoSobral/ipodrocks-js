import ReactMarkdown from "react-markdown";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * Renders markdown content with chat-friendly styling (bold, italic, code, lists).
 */
export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  return (
    <div className={`markdown-chat ${className}`}>
      <ReactMarkdown
        components={{
          p: ({ children }) => <p className="mb-0 last:mb-0">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className: langClass, children, ...props }) => {
            const isBlock = langClass?.startsWith("language-");
            const codeBg =
              "bg-white/10 [.theme-light_&]:bg-black/[0.06]";
            return isBlock ? (
              <code
                className={`block p-2 rounded text-xs overflow-x-auto my-1 ${codeBg}`}
                {...props}
              >
                {children}
              </code>
            ) : (
              <code
                className={`px-1 py-0.5 rounded text-[0.9em] ${codeBg}`}
                {...props}
              >
                {children}
              </code>
            );
          },
          ul: ({ children }) => (
            <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside my-1 space-y-0.5">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="ml-0">{children}</li>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
