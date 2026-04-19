import { useParams, useLocation } from "wouter";
import {
  useGetLead,
  useUpdateLead,
  useEnrichLead,
  useListEmails,
  useGenerateEmail,
  useSendEmail,
  getGetLeadQueryKey,
  getListEmailsQueryKey,
  getListLeadsQueryKey,
  getGetDashboardStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, Mail, Send, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import StageBadge from "@/components/StageBadge";
import { EmailStatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow, format } from "date-fns";

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
        <Link href="/leads">
          <a className="text-sm text-primary mt-2 inline-block">Back to leads</a>
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/leads">
          <a>
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
          </a>
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
              </div>
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

            {lead.intentSignal && (
              <div>
                <p className="text-xs text-muted-foreground font-medium">Intent Signal</p>
                <p className="text-sm text-foreground mt-1 leading-relaxed">
                  {lead.intentSignal}
                </p>
              </div>
            )}

            {!lead.emailValid && !lead.isHiring && !lead.intentSignal && (
              <p className="text-sm text-muted-foreground">
                No enrichment data yet. Click "Enrich" to gather intelligence.
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
