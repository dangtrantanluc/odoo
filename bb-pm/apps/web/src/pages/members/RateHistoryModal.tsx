import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { memberRateCreateSchema, type MemberRateCreateInput } from "@bb-pm/shared";
import {
  createRate,
  deleteRate,
  listRates,
  type Member,
} from "@/features/members/api";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { formatDate, formatMoney } from "@/lib/format";
import { Trash2, Plus } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/features/auth/store";

export function RateHistoryModal({
  open,
  onClose,
  member,
}: {
  open: boolean;
  onClose: () => void;
  member: Member;
}) {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const canEdit = user?.role === "ADMIN" || user?.role === "MANAGER" || user?.isSuperAdmin;
  const [adding, setAdding] = useState(false);

  const ratesQ = useQuery({
    queryKey: ["rates", member.id],
    queryFn: () => listRates(member.id),
    enabled: open,
  });

  const del = useMutation({
    mutationFn: deleteRate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rates", member.id] }),
  });

  const form = useForm<MemberRateCreateInput>({
    resolver: zodResolver(memberRateCreateSchema),
    defaultValues: {
      effectiveFrom: new Date().toISOString().slice(0, 10),
      costPerHour: 0,
    },
  });
  const save = useMutation({
    mutationFn: (v: MemberRateCreateInput) => createRate(member.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rates", member.id] });
      qc.invalidateQueries({ queryKey: ["members", member.projectId] });
      setAdding(false);
      form.reset({ effectiveFrom: new Date().toISOString().slice(0, 10), costPerHour: 0 });
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={`Rate history — ${member.user.fullName}`} size="lg">
      <div className="space-y-4">
        {canEdit && !adding && (
          <button className="btn-primary" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-4 w-4" /> Thêm rate mới
          </button>
        )}

        {adding && canEdit && (
          <form
            onSubmit={form.handleSubmit((v) => save.mutate(v))}
            className="grid grid-cols-3 gap-3 rounded-md border border-slate-200 p-3"
          >
            <div>
              <label className="label">Effective from *</label>
              <input type="date" className="input" {...form.register("effectiveFrom")} />
            </div>
            <div>
              <label className="label">Effective to</label>
              <input type="date" className="input" {...form.register("effectiveTo")} />
            </div>
            <div>
              <label className="label">Rate (VND/giờ) *</label>
              <input type="number" step="1" className="input" {...form.register("costPerHour", { valueAsNumber: true })} />
            </div>
            <div className="col-span-3 flex justify-end gap-2">
              <button type="button" className="btn-ghost border border-slate-200" onClick={() => setAdding(false)}>Hủy</button>
              <button type="submit" className="btn-primary" disabled={save.isPending}>Thêm</button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left dark:bg-slate-800/50">
              <tr>
                <th className="p-3">Từ ngày</th>
                <th className="p-3">Đến ngày</th>
                <th className="p-3">Cost / giờ</th>
                <th className="p-3">Tiền tệ</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {ratesQ.data?.map((r, idx) => {
                const isActive = !r.effectiveTo || new Date(r.effectiveTo) >= new Date();
                return (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="p-3">{formatDate(r.effectiveFrom)}</td>
                    <td className="p-3">{r.effectiveTo ? formatDate(r.effectiveTo) : <Badge className="bg-emerald-100 text-emerald-700">Hiện tại</Badge>}</td>
                    <td className="p-3 font-medium">{formatMoney(r.costPerHour, r.currency?.symbol ?? "₫")}</td>
                    <td className="p-3 text-slate-500">{r.currency?.code ?? "—"}</td>
                    <td className="p-3 text-right">
                      {canEdit && (
                        <button
                          className="rounded p-1 text-red-600 hover:bg-red-50"
                          onClick={() => confirm("Xóa rate này?") && del.mutate(r.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {ratesQ.data?.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-slate-500">Chưa có rate — backlog sẽ không có snapshot cost.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
