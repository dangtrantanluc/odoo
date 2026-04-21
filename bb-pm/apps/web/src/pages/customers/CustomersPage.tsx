import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { customerCreateSchema, type CustomerCreateInput } from "@bb-pm/shared";
import { createCustomer, deleteCustomer, listCustomers, updateCustomer, type Customer } from "@/features/customers/api";
import { Plus, Pencil, Trash2, Search } from "lucide-react";
import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/features/auth/store";

export function CustomersPage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const canEdit = user?.role === "ADMIN" || user?.role === "MANAGER";
  const canDelete = user?.role === "ADMIN";

  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ["customers", q],
    queryFn: () => listCustomers(q || undefined),
  });

  const del = useMutation({
    mutationFn: deleteCustomer,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Khách hàng</h1>
          <p className="text-sm text-slate-500">{query.data?.meta.total ?? 0} khách hàng</p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="input w-64 pl-8" placeholder="Tìm tên…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {canEdit && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" /> Thêm
            </button>
          )}
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left dark:bg-slate-800/50">
            <tr>
              <th className="p-3">Tên</th>
              <th className="p-3">Email</th>
              <th className="p-3">Điện thoại</th>
              <th className="p-3">Mã số thuế</th>
              <th className="p-3">Dự án</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {query.data?.data.map((c) => (
              <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                <td className="p-3 font-medium">{c.name}</td>
                <td className="p-3 text-slate-500">{c.email ?? "—"}</td>
                <td className="p-3 text-slate-500">{c.phone ?? "—"}</td>
                <td className="p-3 text-slate-500">{c.taxCode ?? "—"}</td>
                <td className="p-3">{c._count?.projects ?? 0}</td>
                <td className="p-3 text-right">
                  {canEdit && (
                    <div className="flex justify-end gap-1">
                      <button className="rounded p-1 hover:bg-slate-100" onClick={() => setEditing(c)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {canDelete && (
                        <button
                          className="rounded p-1 text-red-600 hover:bg-red-50"
                          onClick={() => confirm(`Xóa "${c.name}"?`) && del.mutate(c.id)}
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

      <CustomerFormModal open={creating} onClose={() => setCreating(false)} />
      <CustomerFormModal open={!!editing} onClose={() => setEditing(null)} customer={editing} />
    </div>
  );
}

function CustomerFormModal({
  open,
  onClose,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  customer?: Customer | null;
}) {
  const qc = useQueryClient();
  const form = useForm<CustomerCreateInput>({
    resolver: zodResolver(customerCreateSchema),
    values: customer
      ? {
          name: customer.name,
          email: customer.email ?? "",
          phone: customer.phone ?? "",
          address: customer.address ?? "",
          taxCode: customer.taxCode ?? "",
          notes: customer.notes ?? "",
        }
      : undefined,
  });
  const save = useMutation({
    mutationFn: (v: CustomerCreateInput) => (customer ? updateCustomer(customer.id, v) : createCustomer(v)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={customer ? "Sửa khách hàng" : "Thêm khách hàng"}>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-3">
        <div>
          <label className="label">Tên *</label>
          <input className="input" {...form.register("name")} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" {...form.register("email")} />
          </div>
          <div>
            <label className="label">Điện thoại</label>
            <input className="input" {...form.register("phone")} />
          </div>
        </div>
        <div>
          <label className="label">Địa chỉ</label>
          <input className="input" {...form.register("address")} />
        </div>
        <div>
          <label className="label">Mã số thuế</label>
          <input className="input" {...form.register("taxCode")} />
        </div>
        <div>
          <label className="label">Ghi chú</label>
          <textarea rows={2} className="input" {...form.register("notes")} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost border border-slate-200" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn-primary" disabled={save.isPending}>Lưu</button>
        </div>
      </form>
    </Modal>
  );
}
