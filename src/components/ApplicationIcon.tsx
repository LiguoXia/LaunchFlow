import { useEffect, useState, type ReactNode } from 'react';
import { AppWindow } from 'lucide-react';
import type { ApplicationProfile } from '../domain/types';
import { useWorkspace } from '../lib/workspace';
import { loadApplicationIcon } from '../lib/application-icons';

export default function ApplicationIcon({
  profile,
  path,
  size = 32,
  fallback,
}: {
  profile?: ApplicationProfile;
  path?: string;
  size?: number;
  fallback?: ReactNode;
}) {
  const { data } = useWorkspace();
  const file =
    path ??
    (data.os === 'windows'
      ? profile?.launchArguments[0]?.startsWith('shell:AppsFolder\\')
        ? profile.launchArguments[0]
        : profile?.windows.executable
      : profile?.macos.appPath) ??
    '';
  const bundleId = data.os === 'macos' ? (profile?.macos.bundleId ?? '') : '';
  const key = JSON.stringify([file, bundleId]);
  const [icon, setIcon] = useState<{ key: string; src: string | null } | null>(null);
  useEffect(() => {
    let disposed = false;
    // Coalesce card mounts and avoid extracting each partial path while typing.
    const timer = setTimeout(() => {
      void loadApplicationIcon({ path: file, bundleId }).then((src) => {
        if (!disposed) setIcon({ key, src });
      });
    }, 150);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [file, bundleId, key]);
  const src = icon?.key === key ? icon.src : null;
  return (
    <span className="application-icon" style={{ width: size, height: size }} aria-hidden="true">
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          width={size}
          height={size}
          onError={() => setIcon({ key, src: null })}
        />
      ) : (
        (fallback ?? <AppWindow size={size} strokeWidth={1.6} />)
      )}
    </span>
  );
}
