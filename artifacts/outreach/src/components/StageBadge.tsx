import { cn } from "@/lib/utils";

type Stage =
  | "raw"
  | "enriched"
  | "email_generated"
  | "contacted"
  | "replied"
  | "converted"
  | "unsubscribed";

const stageConfig: Record<Stage, { label: string; className: string }> = {
  raw: { label: "Raw", className: "bg-gray-100 text-gray-700 border-gray-200" },
  enriched: { label: "Enriched", className: "bg-blue-50 text-blue-700 border-blue-200" },
  email_generated: { label: "Email Ready", className: "bg-purple-50 text-purple-700 border-purple-200" },
  contacted: { label: "Contacted", className: "bg-amber-50 text-amber-700 border-amber-200" },
  replied: { label: "Replied", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  converted: { label: "Converted", className: "bg-green-100 text-green-800 border-green-200" },
  unsubscribed: { label: "Unsubscribed", className: "bg-red-50 text-red-700 border-red-200" },
};

export default function StageBadge({ stage }: { stage: string }) {
  const config = stageConfig[stage as Stage] ?? {
    label: stage,
    className: "bg-gray-100 text-gray-700 border-gray-200",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border",
        config.className
      )}
    >
      {config.label}
    </span>
  );
}
