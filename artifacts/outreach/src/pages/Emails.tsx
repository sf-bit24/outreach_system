import { useState } from "react";
import { Link } from "wouter";
import {
  useListEmails,
  useListLeads,
  useSendEmail,
  getListEmailsQueryKey,
  getListLeadsQueryKey,
  getGetDashboardStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Mail, Send, ExternalLink, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmailStatusBadge } from "@/components/StatusBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const statusOptions = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "queued", label: "Queued" },
  { value: "sent", label: "Sent" },
  { value: "delivered", label: "Delivered" },
  { value: "opened", label: "Opened" },
  { value: "replied", label: "Replied" },
  { value: "bounced", label: "Bounced" },
  { value: "failed", label: "Failed" },
  { value: "unsubscribed", label: "Unsubscribed" },
];

export default function Emails() {
  const [status, setStatus] = useState<string>("all");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const filter = status === "all" ? {} : { status };
  const { data: emails, isLoading } = useListEmails(filter, {
    query: { queryKey: getListEmailsQueryKey(filter) },
  });

  const { data: leads } = useListLeads(
    {},
    { query: { queryKey: getListLeadsQueryKey() } },
  );

  const sendEmail = useSendEmail();

  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));

  function handleSend(id: number) {
    sendEmail.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEmailsQueryKey(filter) });
          queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
          toast({ title: "Email queued for sending" });
        },
        onError: (e: unknown) => {
          toast({
            title: "Send failed",
            description: (e as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Emails</h1>
          <p className="text-sm text-slate-500 mt-1">
            All AI-generated outreach emails — drafts, queued, sent, and replies
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-400" />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-44" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="text-slate-500 text-sm">Loading...</div>
      ) : !emails || emails.length === 0 ? (
        <div className="border border-dashed border-slate-200 rounded-lg p-12 text-center">
          <Mail className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">No emails yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Generate an email from a lead detail page to see it here
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 font-medium">Recipient</th>
                <th className="px-4 py-3 font-medium">Subject</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Sent</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {emails.map((email) => {
                const lead = leadById.get(email.leadId);
                return (
                  <tr key={email.id} className="hover:bg-slate-50" data-testid={`row-email-${email.id}`}>
                    <td className="px-4 py-3">
                      {lead ? (
                        <Link href={`/leads/${lead.id}`}>
                          <a className="text-slate-700 hover:text-blue-600 inline-flex items-center gap-1">
                            <span className="font-medium">
                              {lead.firstName} {lead.lastName}
                            </span>
                            <ExternalLink className="w-3 h-3 opacity-50" />
                          </a>
                        </Link>
                      ) : (
                        <span className="text-slate-400">Lead #{email.leadId}</span>
                      )}
                      {lead && (
                        <div className="text-xs text-slate-400">{lead.company}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-700 max-w-md truncate">
                        {email.subject}
                      </div>
                      {email.errorMessage && (
                        <div className="text-xs text-red-500 mt-0.5 truncate">
                          {email.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <EmailStatusBadge status={email.status} />
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {email.sentAt ? format(new Date(email.sentAt), "MMM d, HH:mm") : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {email.status === "draft" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSend(email.id)}
                          data-testid={`button-send-${email.id}`}
                        >
                          <Send className="w-3.5 h-3.5 mr-1" /> Send
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
