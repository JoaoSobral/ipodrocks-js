import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className = "", ...props }: InputProps) {
  return (
    <div className={className}>
      {label && (
        <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">{label}</label>
      )}
      <input
        className="w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-[#e0e0e0] placeholder:text-[#5a5f68] outline-none focus:border-[#4a9eff]/50 focus:ring-1 focus:ring-[#4a9eff]/25 transition-colors [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0] [.theme-light_&]:text-[#1a1a1a] [.theme-light_&]:placeholder:text-[#9ca3af]"
        {...props}
      />
    </div>
  );
}
