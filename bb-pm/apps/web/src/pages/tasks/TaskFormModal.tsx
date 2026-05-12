import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { taskCreateSchema, type TaskCreateInput, TaskStatus, Priority } from "@bb-pm/shared";
import { createTask, updateTask, type TaskListItem } from "@/features/tasks/api";
import { listTags } from "@/features/tags/api";
import { listMilestones } from "@/features/milestones/api";
import { Modal } from "@/components/ui/Modal";
import { apiClient } from "@/lib/apiClient";
import { useEffect } from "react";

type UserOption = { id: number; fullName: string; email: string };

async function fetchCompanyUsers() {
  // re-use /me for own company; for full list, backend should expose /users later.
  // Temporary: piggyback from /companies/public + /me. Here we fetch /me as fallback; Sprint 6 will expose users list.
  return [] as UserOption[];
}

export function TaskFormModal({
  open,
  onClose,
  projectId,
  task,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  task?: TaskListItem | null;
}) {
  const qc = useQueryClient();
  const tagsQ = useQuery({ queryKey: ["tags"], queryFn: listTags, enabled: open });
  const msQ = useQuery({
    queryKey: ["milestones", projectId],
    queryFn: () => listMilestones(projectId),
    enabled: open && !!projectId,
  });
  // Members of the project — for assignee dropdown
  const membersQ = useQuery({
    queryKey: ["project-members-light", projectId],
    queryFn: async () => {
      const { data } = await apiClient.get(`/projects/${projectId}`);
      return (data.data.members as any[]).map((m) => m.user as UserOption);
    },
    enabled: open && !!projectId,
  });

  const form = useForm<TaskCreateInput>({
    resolver: zodResolver(taskCreateSchema),
    defaultValues: { priority: "MEDIUM", status: "TODO" },
  });

  useEffect(() => {
    if (task) {
      form.reset({
        name: task.name,
        status: task.status,
        priority: task.priority as any,
        deadline: task.deadline ?? undefined,
        description: task.description ?? undefined,
        assigneeId: task.assignee?.id,
        milestoneId: task.milestone?.id,
        tagIds: task.tags.map((t) => t.id),
      });
    } else if (open) {
      form.reset({ priority: "MEDIUM", status: "TODO", tagIds: [] });
    }
  }, [task, open]);

  const save = useMutation({
    mutationFn: async (v: TaskCreateInput) => (task ? updateTask(task.id, v) : createTask(projectId, v)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["milestones", projectId] });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={task ? "Sửa task" : "Tạo task"} size="lg">
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Tiêu đề *</label>
            <input className="input" {...form.register("name")} />
            {form.formState.errors.name && <p className="mt-1 text-xs text-red-600">{form.formState.errors.name.message}</p>}
          </div>
          <div>
            <label className="label">Trạng thái</label>
            <select className="input" {...form.register("status")}>
              {Object.values(TaskStatus).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Ưu tiên</label>
            <select className="input" {...form.register("priority")}>
              {Object.values(Priority).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Assignee</label>
            <select className="input" {...form.register("assigneeId", { setValueAs: (v) => (v ? Number(v) : undefined) })}>
              <option value="">—</option>
              {membersQ.data?.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Milestone</label>
            <select className="input" {...form.register("milestoneId", { setValueAs: (v) => (v ? Number(v) : undefined) })}>
              <option value="">—</option>
              {msQ.data?.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Deadline</label>
            <input type="date" className="input" {...form.register("deadline")} />
          </div>
          <div>
            <label className="label">End at</label>
            <input type="date" className="input" {...form.register("endAt")} />
          </div>
          <div className="col-span-2">
            <label className="label">Mô tả</label>
            <textarea rows={3} className="input" {...form.register("description")} />
          </div>
          <div className="col-span-2">
            <label className="label">Nhãn</label>
            <div className="flex flex-wrap gap-2">
              {tagsQ.data?.map((t) => {
                const checked = form.watch("tagIds")?.includes(t.id) ?? false;
                return (
                  <label key={t.id} className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${checked ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200"}`}>
                    <input
                      type="checkbox"
                      className="hidden"
                      checked={checked}
                      onChange={(e) => {
                        const curr = form.getValues("tagIds") ?? [];
                        form.setValue("tagIds", e.target.checked ? [...curr, t.id] : curr.filter((id) => id !== t.id));
                      }}
                    />
                    {t.name}
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {save.isError && <p className="text-sm text-red-600">Có lỗi, vui lòng thử lại.</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost border border-slate-200" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn-primary" disabled={save.isPending}>
            {save.isPending ? "Đang lưu…" : "Lưu"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
