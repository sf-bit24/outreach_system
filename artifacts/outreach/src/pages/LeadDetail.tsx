import { useParams, useLocation } from "wouter";
import {
  useGetLead,
  useUpdateLead,
  useEnrichLead,
  useListEmails,
  useGenerateEmail,
  useSendEmail,
  useRunAutoPipeline,
  getGetLeadQueryKey,
  getListEmailsQueryKey,
  getListLeadsQueryKey,
  getGetDashboardStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, Mail, Send, CheckCircle, XCircle, AlertCircle, Search, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import StageBadge from "@/components/StageBadge";
import { EmailStatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow, format } from "date-fns";

const EMAIL_SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  website_crawl: { label: "Site web", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
  hunter_domain: { label: "Hunter domain", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  hunter_finder: { label: "Hunter finder", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  dropcontact:   { label: "Dropcontact",   color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  pre_existing:  { label: "Existant",      color: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
};

function EmailSourceBadge({ source }: { source: string }) {
  const meta = EMAIL_SOURCE_LABELS[source] ?? {
    label: source,
    color: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${meta.color}`}>
      <Search className="w-3 h-3" />
      {meta.label}
    </span>
  );
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const leadId = parseInt(id, 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: lead, isLoading } = useGetLead(leadId, {
    query: { enabled: !!leadId, queryKey: getGetLeadQueryKey(leadId) },
  });

  const { data: emails, isLoading: emailsLoading } = useListEmails(
    { leadId },
    { query: { queryKey: getListEmailsQueryKey({ leadId }) } }
  );

  const enrichLead = useEnrichLead();
  const generateEmail = useGenerateEmail();
  const sendEmail = useSendEmail();
  const runAutoPipeline = useRunAutoPipeline();

  function handleEnrich() {
    enrichLead.mutate(
      { id: leadId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
          queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
          toast({ title: "Lead enriched with intent signals" });
        },
        onError: () => {
          toast({ title: "Enrichment failed", variant: "destructive" });
        },
      }
    );
  }

  function handleRunAutoPipeline() {
    runAutoPipeline.mutate(
      { id: leadId },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getListEmailsQueryKey({ leadId }) });
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
          queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
          toast({ title: data.message ?? "Email généré et mis en queue" });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error ?? "Échec du pipeline automatique";
          toast({ title: msg, variant: "destructive" });
        },
      }
    );
  }

  function handleGenerateEmail() {
    generateEmail.mutate(
      { data: { leadId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmailsQueryKey({ leadId }) });
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
          queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
          toast({ title: "Personalized email generated" });
        },
        onError: () => {
          toast({ title: "Email generation failed", variant: "destructive" });
        },
      }
    );
  }

  function handleSend(emailId: number) {
    sendEmail.mutate(
      { id: emailId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmailsQueryKey({ leadId }) });
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
          queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
          toast({ title: "Email sent successfully" });
        },
        onError: () => {
          toast({ title: "Send failed", variant: "destructive" });
        },
      }
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="text-sm text-muted-foreground">Loading lead...</div>
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="text-sm text-destructive">Lead not found</div>
        <Link href="/leads" className="text-sm text-primary mt-2 inline-block">
          Back to leads
        </Link>
      </div>
    );
  }

  const hasActiveEmail = !emailsLoading && emails?.some(e => e.status !== "failed");
  const canAutoPipeline =
    lead.emailStatus === "verified" &&
    lead.lcapCompliant === true &&
    !hasActiveEmail &&
    !emailsLoading;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/leads">
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
        </Link>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            {lead.firstName} {lead.lastName}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {lead.jobTitle} at {lead.company}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StageBadge stage={lead.stage} />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleEnrich}
            disabled={enrichLead.isPending}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${enrichLead.isPending ? "animate-spin" : ""}`} />
            {enrichLead.isPending ? "Enriching..." : "Enrich"}
          </Button>
          {canAutoPipeline && (
            <Button
              size="sm"
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleRunAutoPipeline}
              disabled={runAutoPipeline.isPending}
              title="Génère un email personnalisé et le met en queue automatiquement"
            >
              <Zap className={`w-3.5 h-3.5 ${runAutoPipeline.isPending ? "animate-pulse" : ""}`} />
              {runAutoPipeline.isPending ? "Pipeline en cours..." : "Lancer pipeline auto"}
            </Button>
          )}
          <Button
            size="sm"
            className="gap-1.5"
            onClick={handleGenerateEmail}
            disabled={generateEmail.isPending}
          >
            <Mail className="w-3.5 h-3.5" />
            {generateEmail.isPending ? "Generating..." : "Generate Email"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Contact info */}
        <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Contact Information</h2>
          <div className="space-y-3">
            {[
              { label: "Email", value: lead.email },
              { label: "Phone", value: lead.phone },
              { label: "Company", value: lead.company },
              { label: "Industry", value: lead.industry },
              { label: "Company Size", value: lead.companySize },
              { label: "Location", value: lead.location },
              { label: "Website", value: lead.website },
              { label: "LinkedIn", value: lead.linkedinUrl },
            ].map(({ label, value }) =>
              value ? (
                <div key={label}>
                  <p className="text-xs text-muted-foreground font-medium">{label}</p>
                  <p className="text-sm text-foreground mt-0.5 break-all">{value}</p>
                </div>
              ) : null
            )}
          </div>
        </div>

        {/* Enrichment data */}
        <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Intelligence</h2>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground font-medium">Email Valid</p>
              <div className="flex items-center gap-1.5 mt-1">
                {lead.emailValid === null ? (
                  <AlertCircle className="w-4 h-4 text-muted-foreground" />
                ) : lead.emailValid ? (
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-500" />
                )}
                <span className="text-sm text-foreground">
                  {lead.emailValid === null
                    ? "Not checked"
                    : lead.emailValid
                    ? "Valid"
                    : "Invalid"}
                </span>
                {lead.emailSource && (
                  <EmailSourceBadge source={lead.emailSource} />
                )}
                {lead.emailStatus === "bounced" && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
                    🚫 Bounced
                  </span>
                )}
              </div>
              {lead.emailStatus === "bounced" && lead.bouncedAt && (
                <p className="text-xs text-red-600 mt-1">
                  Détecté le {new Date(lead.bouncedAt).toLocaleDateString("fr-CA", { year: "numeric", month: "long", day: "numeric" })}
                </p>
              )}
            </div>

            <div>
              <p className="text-xs text-muted-foreground font-medium">Currently Hiring</p>
              <div className="flex items-center gap-1.5 mt-1">
                {lead.isHiring === null ? (
                  <span className="text-sm text-muted-foreground">Unknown</span>
                ) : lead.isHiring ? (
                  <>
                    <CheckCircle className="w-4 h-4 text-emerald-500" />
                    <span className="text-sm text-foreground">Yes</span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-foreground">No</span>
                  </>
                )}
              </div>
            </div>

            {/* LCAP Compliance */}
            <div>
              <p className="text-xs text-muted-foreground font-medium">Conformité LCAP (C-28)</p>
              <div className="flex items-center gap-1.5 mt-1">
                {lead.lcapCompliant === null || lead.lcapCompliant === undefined ? (
                  <AlertCircle className="w-4 h-4 text-muted-foreground" />
                ) : lead.lcapCompliant ? (
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-500" />
                )}
                <span className="text-sm text-foreground">
                  {lead.lcapCompliant === null || lead.lcapCompliant === undefined
                    ? "Non évalué"
                    : lead.lcapCompliant
                    ? "Conforme"
                    : "Non conforme"}
                </span>
              </div>
              {lead.lcapReason && (
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {lead.lcapReason}
                </p>
              )}
            </div>

            {lead.intentSignal && (
              <div>
                <p className="text-xs text-muted-foreground font-medium">Intent Signal</p>
                <p className="text-sm text-foreground mt-1 leading-relaxed">
                  {lead.intentSignal}
                </p>
              </div>
            )}

            {lead.painPoint && (
              <div>
                <p className="text-xs text-muted-foreground font-medium">Pain Point détecté</p>
                <p className="text-sm text-foreground mt-1 leading-relaxed">{lead.painPoint}</p>
              </div>
            )}

            {lead.websiteSummary && (
              <div>
                <p className="text-xs text-muted-foreground font-medium">Résumé site web</p>
                <p className="text-sm text-foreground mt-1 leading-relaxed">{lead.websiteSummary}</p>
              </div>
            )}

            {lead.websiteKeywords && (
              <div>
                <p className="text-xs text-muted-foreground font-medium">Mots-clés</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {lead.websiteKeywords.split(",").map((kw) => kw.trim()).filter(Boolean).map((kw) => (
                    <span key={kw} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-muted text-muted-foreground">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {lead.emailValid === null && lead.lcapCompliant === null && !lead.isHiring && !lead.intentSignal && (
              <p className="text-sm text-muted-foreground">
                Aucune donnée d'enrichissement. Cliquez sur "Enrich" pour analyser ce lead.
              </p>
            )}
          </div>

          {lead.notes && (
            <div>
              <p className="text-xs text-muted-foreground font-medium">Notes</p>
              <p className="text-sm text-foreground mt-1 leading-relaxed">{lead.notes}</p>
            </div>
          )}
        </div>

        {/* Timeline */}
        <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Timeline</h2>
          <div className="space-y-2">
            <div>
              <p className="text-xs text-muted-foreground">Added</p>
              <p className="text-sm text-foreground">
                {format(new Date(lead.createdAt), "MMM d, yyyy")}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last updated</p>
              <p className="text-sm text-foreground">
                {formatDistanceToNow(new Date(lead.updatedAt), { addSuffix: true })}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Emails */}
      <div className="bg-card border border-card-border rounded-lg p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">
          Emails {emails ? `(${emails.length})` : ""}
        </h2>

        {emailsLoading ? (
          <p className="text-sm text-muted-foreground">Loading emails...</p>
        ) : emails && emails.length > 0 ? (
          <div className="space-y-4">
            {emails.map((email) => (
              <div key={email.id} className="border border-border rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-medium text-foreground truncate">
                        {email.subject}
                      </p>
                      <EmailStatusBadge status={email.status} />
                    </div>
                    {email.hook && (
                      <p className="text-xs text-muted-foreground italic mb-2">
                        Hook: {email.hook}
                      </p>
                    )}
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans bg-muted/30 rounded p-3 max-h-40 overflow-auto">
                      {email.body}
                    </pre>
                  </div>
                  <div className="flex-shrink-0">
                    {email.status === "draft" && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => handleSend(email.id)}
                        disabled={sendEmail.isPending}
                      >
                        <Send className="w-3.5 h-3.5" />
                        Send
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {formatDistanceToNow(new Date(email.createdAt), { addSuffix: true })}
                  {email.sentAt && ` · Sent ${format(new Date(email.sentAt), "MMM d")}`}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-6">
            <p className="text-sm text-muted-foreground">No emails yet for this lead.</p>
            <Button
              size="sm"
              className="mt-3 gap-1.5"
              onClick={handleGenerateEmail}
              disabled={generateEmail.isPending}
            >
              <Mail className="w-3.5 h-3.5" />
              Generate Email
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
