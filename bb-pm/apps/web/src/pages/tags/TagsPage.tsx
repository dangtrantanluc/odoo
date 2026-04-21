import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { tagCreateSchema, type TagCreateInput } from "@bb-pm/shared";
import { createTag, deleteTag, listTags, updateTag, type Tag } from "@/features/tags/api";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/features/auth/store";

const COLOR_CLASSES = [
  "bg-slate-200 text-slate-700",
  "bg-red-200 text-red-800",
  "bg-orange-200 text-orange-800",
  "bg-amber-200 text-amber-800",
  "bg-lime-200 text-lime-800",
  "bg-emerald-200 text-emerald-800",
  "bg-teal-200 text-teal-800",
  "bg-sky-200 text-sky-800",
  "bg-blue-200 text-blue-800",
  "bg-violet-200 text-violet-800",
  "bg-pink-200 text-pink-800",
  "bg-rose-200 text-rose-800",
];

export function TagsPage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const canEdit = user?.role === "ADMIN" || user?.role === "MANAGER";
  const canDelete = user?.role === "ADMIN";

  const { data: tags = [], isLoading } = useQuery({ queryKey: ["tags"], queryFn: listTags });
  const [editing, setEditing] = useState<Tag | null>(null);
  const [creating, setCreating] = useState(false);

  const del = useMutation({
    mutationFn: deleteTag,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
  });

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Nhãn</h1>
        {canEdit && (
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-4 w-4" /> Tạo nhãn
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">Đang tải…</p>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left dark:bg-slate-800/50">
              <tr>
                <th className="p-3">Nhãn</th>
                <th className="p-3">Dùng ở</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr key={t.id} className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                  <td className="p-3">
                    <Badge className={COLOR_CLASSES[(t.color ?? 0) % COLOR_CLASSES.length]}>{t.name}</Badge>
                  </td>
                  <td className="p-3 text-slate-500">
                    {t._count?.projects ?? 0} projects · {t._count?.tasks ?? 0} tasks
                  </td>
                  <td className="p-3 text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <button className="rounded p-1 hover:bg-slate-100" onClick={() => setEditing(t)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {canDelete && (
                          <button
                            className="rounded p-1 text-red-600 hover:bg-red-50"
                            onClick={() => confirm(`Xóa nhãn "${t.name}"?`) && del.mutate(t.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TagFormModal open={creating} onClose={() => setCreating(false)} />
      <TagFormModal open={!!editing} onClose={() => setEditing(null)} tag={editing} />
    </div>
  );
}

function TagFormModal({ open, onClose, tag }: { open: boolean; onClose: () => void; tag?: Tag | null }) {
  const qc = useQueryClient();
  const form = useForm<TagCreateInput>({
    resolver: zodResolver(tagCreateSchema),
    defaultValues: { name: tag?.name ?? "", color: tag?.color ?? 0 },
    values: tag ? { name: tag.name, color: tag.color ?? 0 } : undefined,
  });
  const save = useMutation({
    mutationFn: (v: TagCreateInput) => (tag ? updateTag(tag.id, v) : createTag(v)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tags"] });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={tag ? "Sửa nhãn" : "Tạo nhãn"}>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
        <div>
          <label className="label">Tên *</label>
          <input className="input" {...form.register("name")} />
        </div>
        <div>
          <label className="label">Màu</label>
          <div className="flex flex-wrap gap-2">
            {COLOR_CLASSES.map((cls, i) => {
              const active = form.watch("color") === i;
              return (
                <button
                  key={i}
                  type="button"
                  className={`h-8 w-8 rounded-full ${cls} ${active ? "ring-2 ring-offset-2 ring-brand-500" : ""}`}
                  onClick={() => form.setValue("color", i)}
                />
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost border border-slate-200" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn-primary" disabled={save.isPending}>Lưu</button>
        </div>
      </form>
    </Modal>
  );
}
