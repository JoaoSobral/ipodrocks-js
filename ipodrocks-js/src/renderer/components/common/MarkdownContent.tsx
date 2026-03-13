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
            <strong className="font-semibold text-[#e8eaed] [.theme-light_&]:text-[#1a1a1a]">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic text-[#c0c4cc] [.theme-light_&]:text-[#4b5563]">
              {children}
            </em>
          ),
          h1: ({ children }) => (
            <h1 className="text-base font-semibold mt-3 mb-1.5 first:mt-0 text-white [.theme-light_&]:text-[#1a1a1a]">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-sm font-semibold mt-3 mb-1 first:mt-0 text-[#e0e0e0] [.theme-light_&]:text-[#374151]">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-medium mt-2 mb-1 text-[#d0d4d8] [.theme-light_&]:text-[#4b5563]">
              {children}
            </h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[#4a9eff]/40 pl-3 my-2 text-[#b0b4b8] [.theme-light_&]:border-[#4a9eff]/50 [.theme-light_&]:text-[#6b7280]">
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
                className="text-[#4a9eff] hover:text-[#6ab0ff] underline [.theme-light_&]:text-[#2563eb] [.theme-light_&]:hover:text-[#3b82f6]"
              >
                {children}
              </a>
            );
          },
          code: ({ className: langClass, children, ...props }) => {
            const isBlock = langClass?.startsWith("language-");
            const codeBg =
              "bg-white/10 [.theme-light_&]:bg-black/[0.06]";
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
            <hr className="border-white/10 my-2 [.theme-light_&]:border-[#e5e7eb]" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
