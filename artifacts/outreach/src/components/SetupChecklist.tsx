import { CheckCircle2, Circle, X, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { useGetSenderSettings, getGetSenderSettingsQueryKey } from "@workspace/api-client-react";

interface SetupChecklistProps {
  totalLeads: number;
  emailsSent: number;
}

export default function SetupChecklist({ totalLeads, emailsSent }: SetupChecklistProps) {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem("setup_checklist_dismissed") === "true";
  });
  const [expanded, setExpanded] = useState(true);

  const { data: settings } = useGetSenderSettings({
    query: { queryKey: getGetSenderSettingsQueryKey() },
  });

  if (dismissed) return null;

  const steps = [
    {
      id: "smtp",
      label: "Transport email configuré (SMTP ou Resend)",
      done: !!settings && settings.transportMode !== "simulation",
      href: "/settings",
      hint: "Configurez votre boîte Hostinger dans Paramètres → Transport",
    },
    {
      id: "address",
      label: "Adresse physique LCAP renseignée",
      done: !!settings?.senderAddress && settings.senderAddress.trim().length > 5,
      href: "/settings",
      hint: "Obligatoire légalement (Loi C-28) — ajoutez votre adresse au Québec",
    },
    {
      id: "lead",
      label: "Premier lead importé",
      done: totalLeads > 0,
      href: "/sources",
      hint: "Importez via Google Maps, CSV ou saisie manuelle",
    },
    {
      id: "sent",
      label: "Premier email de test envoyé",
      done: emailsSent > 0,
      href: "/settings",
      hint: "Utilisez le bouton « Envoyer test » dans Paramètres",
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const allDone = completedCount === steps.length;

  if (allDone) {
    return null;
  }

  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between px-5 py-3.5 cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            {steps.map((s) =>
              s.done ? (
                <CheckCircle2 key={s.id} className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Circle key={s.id} className="w-3.5 h-3.5 text-muted-foreground/40" />
              )
            )}
          </div>
          <span className="text-sm font-medium text-foreground">
            Mise en service —{" "}
            <span className="text-muted-foreground font-normal">
              {completedCount}/{steps.length} étapes complétées
            </span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              localStorage.setItem("setup_checklist_dismissed", "true");
              setDismissed(true);
            }}
            className="p-0.5 rounded hover:bg-muted transition-colors"
            title="Fermer"
          >
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-card-border divide-y divide-card-border">
          {steps.map((step) => (
            <div key={step.id} className="flex items-start gap-3 px-5 py-3">
              {step.done ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
              ) : (
                <Circle className="w-4 h-4 text-muted-foreground/40 mt-0.5 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <span
                  className={`text-sm ${step.done ? "text-muted-foreground line-through" : "text-foreground font-medium"}`}
                >
                  {step.label}
                </span>
                {!step.done && (
                  <p className="text-xs text-muted-foreground mt-0.5">{step.hint}</p>
                )}
              </div>
              {!step.done && (
                <Link href={step.href}>
                  <span className="text-xs text-primary hover:underline cursor-pointer whitespace-nowrap">
                    Configurer →
                  </span>
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
