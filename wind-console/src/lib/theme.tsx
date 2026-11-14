import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "dark" | "light" | "system";
const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void; resolved: "dark" | "light" }>({ theme: "system", setTheme: () => {}, resolved: "dark" });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem("wind-theme");
    return saved === "dark" || saved === "light" ? saved : "system";
  });
  const resolved = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  useEffect(() => {
    localStorage.setItem("wind-theme", theme);
    document.documentElement.dataset.theme = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  }, [theme]);
  return <ThemeCtx.Provider value={{ theme, setTheme: setThemeState, resolved }}>{children}</ThemeCtx.Provider>;
}
export const useTheme = () => useContext(ThemeCtx);
