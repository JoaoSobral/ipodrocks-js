interface DeviceIconProps {
  src: string | null;
  alt: string;
  size: "sm" | "md";
  connected?: boolean | null;
}

const SIZE_CLASSES = {
  sm: "w-8 h-8 rounded-lg",
  md: "w-10 h-10 rounded-xl",
} as const;

const IMG_RADIUS = {
  sm: "",
  md: "rounded-xl",
} as const;

export function DeviceIcon({ src, alt, size, connected }: DeviceIconProps) {
  const showStatus = connected !== null && connected !== undefined;
  // overflow-hidden would clip the status badge, which sits at -top-1 -left-1
  const overflow = showStatus ? "" : "overflow-hidden";
  return (
    <div
      className={`relative ${SIZE_CLASSES[size]} flex items-center justify-center flex-shrink-0 ${overflow}`}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          className={`w-full h-full object-contain ${IMG_RADIUS[size]}`}
        />
      ) : null}
      {showStatus && (
        <span
          className={`absolute -top-1 -left-1 w-4 h-4 rounded-full border-2 border-card ${
            connected ? "bg-green-500" : "bg-red-500"
          }`}
          title={connected ? "Device connected" : "Device not connected"}
        />
      )}
    </div>
  );
}
