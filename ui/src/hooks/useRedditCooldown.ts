import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "reddit-cooldown-end";

function getRemainingSeconds(): number {
  try {
    const end = localStorage.getItem(STORAGE_KEY);
    if (!end) return 0;
    const remaining = Math.ceil((parseInt(end, 10) - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
  } catch {
    return 0;
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function useRedditCooldown() {
  const [remainingSeconds, setRemainingSeconds] = useState<number>(getRemainingSeconds);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startInterval = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const rem = getRemainingSeconds();
      setRemainingSeconds(rem);
      if (rem <= 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 1000);
  }, []);

  useEffect(() => {
    if (remainingSeconds > 0) {
      startInterval();
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync across tabs
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const rem = getRemainingSeconds();
        setRemainingSeconds(rem);
        if (rem > 0) startInterval();
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [startInterval]);

  const startCooldown = useCallback(() => {
    const minutes = 5 + Math.random() * 5; // 5–10 min
    const endTs = Date.now() + Math.round(minutes * 60 * 1000);
    try {
      localStorage.setItem(STORAGE_KEY, String(endTs));
    } catch {
      // ignore
    }
    const rem = getRemainingSeconds();
    setRemainingSeconds(rem);
    startInterval();
  }, [startInterval]);

  return {
    remainingSeconds,
    isActive: remainingSeconds > 0,
    formattedTime: formatTime(remainingSeconds),
    startCooldown,
  };
}
