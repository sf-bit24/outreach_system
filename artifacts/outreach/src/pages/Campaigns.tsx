import { useState } from "react";
import { Link } from "wouter";
import {
  useListCampaigns,
  useCreateCampaign,
  useStartCampaign,
  usePauseCampaign,
  getListCampaignsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Megaphone, Play, Pause, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { format } from "date-fns";

const createSchema = z.object({
  name: z.string().min(1, "Required"),
  description: z.string().optional(),
  sendingDelayMinutes: z.coerce.number().min(0).optional(),
  dailyLimit: z.coerce.number().min(1).optional(),
});

type CreateForm = z.infer<typeof createSchema>;

const statusStyles: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  active: "bg-emerald-100 text-emerald-700",
  paused: "bg-amber-100 text-amber-700",
  completed: "bg-blue-100 text-blue-700",
};

export default function Campaigns() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const { data: campaigns, isLoading } = useListCampaigns({
    query: { queryKey: getListCampaignsQueryKey() },
  });

  const createCampaign = useCreateCampaign();
  const startCampaign = useStartCampaign();
  const pauseCampaign = usePauseCampaign();

  const form = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: "",
      description: "",
      sendingDelayMinutes: 2,
      dailyLimit: 50,
    },
  });

  function onSubmit(data: CreateForm) {
    createCampaign.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
          setOpen(false);
          form.reset();
          toast({ title: "Campaign created" });
        },
        onError: () => toast({ title: "Failed to create campaign", variant: "destructive" }),
      },
    );
  }

  function handleStart(id: number) {
    startCampaign.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
          toast({ title: "Campaign started" });
        },
      },
    );
  }

  function handlePause(id: number) {
    pauseCampaign.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
          toast({ title: "Campaign paused" });
        },
      },
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Campaigns</h1>
          <p className="text-sm text-slate-500 mt-1">
            Group leads into outreach campaigns and orchestrate sending
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-campaign">
              <Plus className="w-4 h-4 mr-2" /> New campaign
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New campaign</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input data-testid="input-campaign-name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea rows={3} {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="sendingDelayMinutes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Delay (min)</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="dailyLimit"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Daily limit</FormLabel>
                        <FormControl>
                          <Input type="number" {...field} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" data-testid="button-submit-campaign">
                    Create
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-slate-500 text-sm">Loading...</div>
      ) : !campaigns || campaigns.length === 0 ? (
        <div className="border border-dashed border-slate-200 rounded-lg p-12 text-center">
          <Megaphone className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">No campaigns yet</p>
          <p className="text-sm text-slate-500 mt-1">
            Create your first campaign to start orchestrating outreach
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {campaigns.map((c) => (
            <div
              key={c.id}
              className="bg-white rounded-lg border border-slate-200 p-5 hover:border-slate-300 transition-colors"
              data-testid={`card-campaign-${c.id}`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <Link href={`/campaigns/${c.id}`}>
                    <a className="font-semibold text-slate-900 hover:text-blue-600 inline-flex items-center gap-1">
                      {c.name}
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </Link>
                  {c.description && (
                    <p className="text-sm text-slate-500 mt-1 line-clamp-2">{c.description}</p>
                  )}
                </div>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusStyles[c.status] ?? "bg-slate-100 text-slate-700"}`}
                >
                  {c.status}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                <div className="bg-slate-50 rounded-md py-2">
                  <div className="text-lg font-semibold text-slate-900">{c.totalLeads}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">Leads</div>
                </div>
                <div className="bg-slate-50 rounded-md py-2">
                  <div className="text-lg font-semibold text-slate-900">{c.contacted}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">Contacted</div>
                </div>
                <div className="bg-slate-50 rounded-md py-2">
                  <div className="text-lg font-semibold text-emerald-600">{c.replied}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">Replied</div>
                </div>
              </div>

              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-100">
                <span className="text-xs text-slate-400">
                  Created {format(new Date(c.createdAt), "MMM d, yyyy")}
                </span>
                <div className="flex gap-2">
                  {c.status === "active" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handlePause(c.id)}
                      data-testid={`button-pause-${c.id}`}
                    >
                      <Pause className="w-3.5 h-3.5 mr-1" /> Pause
                    </Button>
                  ) : c.status !== "completed" ? (
                    <Button
                      size="sm"
                      onClick={() => handleStart(c.id)}
                      data-testid={`button-start-${c.id}`}
                    >
                      <Play className="w-3.5 h-3.5 mr-1" /> Start
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
