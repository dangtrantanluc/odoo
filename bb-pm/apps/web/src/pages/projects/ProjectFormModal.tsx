import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { projectCreateSchema, type ProjectCreateInput, ProjectStatus, Priority } from "@bb-pm/shared";
import { createProject, updateProject, type ProjectListItem } from "@/features/projects/api";
import { listCustomers } from "@/features/customers/api";
import { listTags } from "@/features/tags/api";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/features/auth/store";
import { useEffect } from "react";

export function ProjectFormModal({
  open,
  onClose,
  project,
}: {
  open: boolean;
  onClose: () => void;
  project?: ProjectListItem | null;
}) {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user)!;
  const customersQ = useQuery({ queryKey: ["customers"], queryFn: () => listCustomers(), enabled: open });
  const tagsQ = useQuery({ queryKey: ["tags"], queryFn: listTags, enabled: open });

  const form = useForm<ProjectCreateInput>({
    resolver: zodResolver(projectCreateSchema),
    defaultValues: { ownerId: user.id, priority: "MEDIUM", status: "PLANNED" },
  });

  useEffect(() => {
    if (project) {
      form.reset({
        name: project.name,
        code: project.code ?? "",
        status: project.status,
        priority: project.priority as any,
        ownerId: project.owner.id,
        customerId: project.customer?.id,
        budget: project.budget ? Number(project.budget) : undefined,
        startDate: project.startDate ?? undefined,
        endDate: project.endDate ?? undefined,
        tagIds: project.tags.map((t) => t.id),
      } as any);
    } else if (open) {
      form.reset({ ownerId: user.id, priority: "MEDIUM", status: "PLANNED" });
    }
  }, [project, open]);

  const save = useMutation({
    mutationFn: async (v: ProjectCreateInput) => (project ? updateProject(project.id, v) : createProject(v)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={project ? "Sửa dự án" : "Tạo dự án"} size="lg">
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Tên dự án *</label>
            <input className="input" {...form.register("name")} />
            {form.formState.errors.name && <p className="mt-1 text-xs text-red-600">{form.formState.errors.name.message}</p>}
          </div>
          <div>
            <label className="label">Mã</label>
            <input className="input" {...form.register("code")} />
          </div>
          <div>
            <label className="label">Khách hàng</label>
            <select className="input" {...form.register("customerId", { setValueAs: (v) => (v ? Number(v) : undefined) })}>
              <option value="">—</option>
              {customersQ.data?.data.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Trạng thái</label>
            <select className="input" {...form.register("status")}>
              {Object.values(ProjectStatus).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Ưu tiên</label>
            <select className="input" {...form.register("priority")}>
              {Object.values(Priority).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Ngày bắt đầu</label>
            <input type="date" className="input" {...form.register("startDate")} />
          </div>
          <div>
            <label className="label">Ngày kết thúc</label>
            <input type="date" className="input" {...form.register("endDate")} />
          </div>
          <div className="col-span-2">
            <label className="label">Ngân sách (VND)</label>
            <input type="number" className="input" {...form.register("budget", { setValueAs: (v) => (v === "" ? undefined : Number(v)) })} />
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
