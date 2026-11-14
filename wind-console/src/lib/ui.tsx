// Wind components: HeroUI v3 anatomy, React edition. Class names use the
// Tailwind theme tokens from index.css; variants are props, never raw colors.
import { motion, AnimatePresence } from "framer-motion";
import { createContext, forwardRef, useContext, useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const EASE = [0.23, 1, 0.32, 1] as const;

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/* ---- Button ---- */
type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost" | "outline" | "danger" | "danger-soft";
const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-[var(--accent-hover)]",
  secondary: "bg-default text-accent-soft-fg hover:bg-[var(--default-hover)]",
  tertiary: "bg-transparent text-muted hover:bg-default hover:text-foreground",
  ghost: "bg-transparent text-default-foreground hover:bg-default",
  outline: "bg-transparent text-default-foreground hover:bg-default border border-border",
  danger: "bg-danger text-accent-fg hover:bg-[var(--danger-hover)]",
  "danger-soft": "bg-danger-soft text-danger-soft-fg hover:bg-[color-mix(in_oklab,var(--danger)_26%,transparent)]"
};
const buttonSizes = { sm: "h-8 px-3 text-xs", md: "h-9 px-4 text-sm", lg: "h-11 px-5 text-base" };
export function Button({
  variant = "primary",
  size = "md",
  icon,
  className,
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: keyof typeof buttonSizes; icon?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "relative inline-flex w-fit select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium outline-none transition-transform active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
        buttonVariants[variant],
        buttonSizes[size],
        className
      )}
      style={{ transitionDuration: "160ms", transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)" }}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/* ---- Card ---- */
export function Card({ className, children }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("flex flex-col gap-3 rounded-[min(32px,var(--radius-3xl))] bg-surface p-4 shadow-[var(--surface-shadow)]", className)}>
      {children}
    </div>
  );
}
export function CardHeader({ className, children }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("flex flex-col", className)}>{children}</div>;
}
export function CardTitle({ className, children }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cx("text-sm font-medium leading-6 text-foreground", className)}>{children}</h3>;
}
export function CardDescription({ className, children }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx("text-sm leading-5 text-muted", className)}>{children}</p>;
}
export function CardContent({ className, children }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("flex flex-1 flex-col gap-1", className)}>{children}</div>;
}
export function CardFooter({ className, children }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("flex items-center", className)}>{children}</div>;
}

/* ---- Chip ---- */
type ChipVariant = "default" | "accent" | "success" | "warning" | "danger" | "solid-accent" | "solid-success";
const chipVariants: Record<ChipVariant, string> = {
  default: "bg-default text-default-foreground",
  accent: "bg-accent-soft text-accent-soft-fg",
  success: "bg-success-soft text-success-soft-fg",
  warning: "bg-warning-soft text-warning-soft-fg",
  danger: "bg-danger-soft text-danger-soft-fg",
  "solid-accent": "bg-accent text-accent-fg",
  "solid-success": "bg-success text-success-foreground"
};
export function Chip({ variant = "default", className, children }: { variant?: ChipVariant; className?: string; children: ReactNode }) {
  return <span className={cx("inline-flex w-fit shrink-0 items-center gap-1 rounded-2xl px-2 py-0.5 text-xs font-medium leading-5", chipVariants[variant], className)}>{children}</span>;
}

/* ---- Tabs (segmented) ---- */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: { options: Array<{ value: T; label: ReactNode }>; value: T; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex gap-0.5 rounded-[calc(var(--radius)*2.5)] bg-default p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative flex h-8 items-center justify-center rounded-full px-4 text-sm font-medium outline-none transition-colors",
              on ? "text-foreground" : "text-muted hover:text-foreground"
            )}
          >
            {on && (
              <motion.span
                layoutId={"seg-" + ariaLabel}
                className="absolute inset-0 rounded-full bg-[var(--segment)] shadow-[var(--surface-shadow)]"
                transition={{ type: "spring", bounce: 0, duration: 0.35 }}
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---- Field pieces ---- */
export function Label({ className, children, htmlFor }: { className?: string; children: ReactNode; htmlFor?: string }) {
  return <label htmlFor={htmlFor} className={cx("text-sm font-medium", className)}>{children}</label>;
}
const fieldBase =
  "h-10 w-full rounded-[var(--field-radius)] border-0 bg-[var(--field-background)] px-3 text-sm text-[var(--field-foreground)] shadow-[var(--field-shadow)] outline-none placeholder:text-[var(--field-placeholder)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:bg-[var(--field-hover)]";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(fieldBase, className)} {...rest} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, "h-auto min-h-24 py-2.5 leading-5", className)} {...rest} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(fieldBase, "appearance-none pr-9", className)} {...rest}>
      {children}
    </select>
  );
});

/* ---- Switch ---- */
export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-3 text-start disabled:opacity-50"
    >
      <span
        className={cx(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200",
          checked ? "bg-accent group-hover:bg-[var(--accent-hover)]" : "bg-default group-hover:bg-[var(--default-hover)]"
        )}
      >
        <motion.span
          animate={{ x: checked ? 20 : 0, width: "auto" }}
          transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
          className="absolute left-[3px] top-[3px] block h-[18px] w-[18px] rounded-full bg-white"
          whileTap={{ scaleX: 1.2 }}
        />
      </span>
      {(label || description) && (
        <span className="flex flex-col">
          {label && <span className="text-sm font-medium">{label}</span>}
          {description && <span className="text-xs leading-5 text-muted">{description}</span>}
        </span>
      )}
    </button>
  );
}

/* ---- Meter / ProgressBar ---- */
export function Meter({ value, max = 100, color = "accent", label, output, size = "md" }: { value: number; max?: number; color?: "accent" | "success" | "warning" | "danger"; label?: ReactNode; output?: ReactNode; size?: "sm" | "md" | "lg" }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const h = size === "sm" ? "h-1" : size === "lg" ? "h-3" : "h-2";
  const fill = { accent: "bg-accent", success: "bg-success", warning: "bg-warning", danger: "bg-danger" }[color];
  return (
    <div className="grid w-full gap-1" style={{ gridTemplate: '"label output" "track track"', gridTemplateColumns: "1fr auto" }}>
      {label != null && <div className="w-fit text-sm font-medium" style={{ gridArea: "label" }}>{label}</div>}
      {output != null && <div className="text-sm font-medium tabular-nums" style={{ gridArea: "output" }}>{output}</div>}
      <div className={cx("relative overflow-hidden rounded-sm bg-default", h)} style={{ gridArea: "track" }} role="progressbar" aria-valuenow={value} aria-valuemax={max}>
        <motion.div className={cx("absolute inset-y-0 left-0 rounded-sm", fill)} animate={{ width: pct + "%" }} transition={{ duration: 0.3, ease: EASE }} />
      </div>
    </div>
  );
}

/* ---- Skeleton ---- */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cx("pointer-events-none relative h-9 overflow-hidden rounded-md bg-[color-mix(in_oklab,var(--surface-tertiary)_70%,transparent)]", className)}>
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.8s_linear_infinite] bg-gradient-to-r from-transparent via-[var(--surface-tertiary)] to-transparent" />
    </div>
  );
}

/* ---- Spinner ---- */
export function Spinner({ size = 22, className }: { size?: number; className?: string }) {
  return <span className={cx("inline-flex animate-spin rounded-full border-2 border-default border-t-accent", className)} style={{ width: size, height: size }} />;
}

/* ---- Avatar ---- */
export function Avatar({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={cx("inline-grid place-items-center rounded-full bg-accent text-accent-fg font-semibold", className)} style={{ width: size, height: size, fontSize: size * 0.44 }}>
      {initial}
    </span>
  );
}

/* ---- Kbd ---- */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 items-center rounded-md border border-border bg-surface px-1.5 font-mono text-[11px] text-muted shadow-[var(--surface-shadow)]">{children}</kbd>;
}

/* ---- Separator ---- */
export function Separator({ className }: { className?: string }) {
  return <hr className={cx("border-0 h-px bg-separator", className)} />;
}

/* ---- Toast ---- */
type Toast = { id: number; message: string; variant: "accent" | "success" | "danger" };
const ToastCtx = createContext<(message: string, variant?: Toast["variant"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
const toastVariants = { accent: "bg-accent-soft text-accent-soft-fg", success: "bg-success-soft text-success-soft-fg", danger: "bg-danger-soft text-danger-soft-fg" };
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (message: string, variant: Toast["variant"] = "accent") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, variant }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex flex-col items-end gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ duration: 0.18, ease: EASE }}
              className={cx("pointer-events-auto rounded-2xl px-4 py-2.5 text-sm font-medium shadow-[var(--overlay-shadow)]", toastVariants[t.variant])}
            >
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

/* ---- Tooltip ---- */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      {children}
      <AnimatePresence>
        {open && (
          <motion.span
            initial={{ opacity: 0, y: 3, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.15, ease: EASE }}
            className="pointer-events-none absolute -top-2 left-1/2 z-50 w-max max-w-xs -translate-x-1/2 -translate-y-full rounded-xl bg-overlay px-2.5 py-1.5 text-xs leading-4 text-overlay-foreground shadow-[var(--overlay-shadow)]"
            style={{ transformOrigin: "50% 100%" }}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/* ---- Modal ---- */
export function Modal({ open, onClose, title, children, width = 480 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] grid place-items-center bg-[var(--backdrop)] p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
          role="dialog"
          aria-modal="true"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="w-full rounded-[24px] bg-overlay p-6 shadow-[var(--overlay-shadow)]"
            style={{ maxWidth: width }}
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <h3 className="text-base font-semibold">{title}</h3>
              <Button variant="tertiary" size="sm" onClick={onClose} aria-label="Close">Close</Button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
