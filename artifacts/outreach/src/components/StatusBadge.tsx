import { cn } from "@/lib/utils";

type CampaignStatus = "draft" | "active" | "paused" | "completed";
type EmailStatus =
  | "draft"
  | "queued"
  | "sent"
  | "delivered"
  | "opened"
  | "replied"
  | "bounced"
  | "failed"
  | "unsubscribed";

const campaignConfig: Record<CampaignStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-gray-100 text-gray-700 border-gray-200" },
  active: { label: "Active", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  paused: { label: "Paused", className: "bg-amber-50 text-amber-700 border-amber-200" },
  completed: { label: "Completed", className: "bg-blue-50 text-blue-700 border-blue-200" },
};

const emailConfig: Record<EmailStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-gray-100 text-gray-700 border-gray-200" },
  queued: { label: "Queued", className: "bg-amber-50 text-amber-700 border-amber-200" },
  sent: { label: "Sent", className: "bg-blue-50 text-blue-700 border-blue-200" },
  delivered: { label: "Delivered", className: "bg-sky-50 text-sky-700 border-sky-200" },
  opened: { label: "Opened", className: "bg-purple-50 text-purple-700 border-purple-200" },
  replied: { label: "Replied", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  bounced: { label: "Bounced", className: "bg-red-50 text-red-700 border-red-200" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700 border-red-200" },
  unsubscribed: { label: "Unsubscribed", className: "bg-slate-100 text-slate-600 border-slate-200" },
};

export function CampaignStatusBadge({ status }: { status: string }) {
  const config = campaignConfig[status as CampaignStatus] ?? {
    label: status,
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

export function EmailStatusBadge({ status }: { status: string }) {
  const config = emailConfig[status as EmailStatus] ?? {
    label: status,
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
