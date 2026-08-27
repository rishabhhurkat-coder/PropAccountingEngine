import { Eye, EyeOff, Pencil, Plus, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPropUser, getPropUsers, updatePropUser } from '../lib/api'
import { isAdminUser } from '../lib/auth'
import type { PropUser, PropUserInput } from '../types'
import { SectionHeader } from '../components/PipelineUI'

const EMPTY_FORM: PropUserInput = { user_name: '', password: '', user_class: 'Staff', is_active: true }

export function UserManagement() {
  const [users, setUsers] = useState<PropUser[]>([])
  const [form, setForm] = useState<PropUserInput>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  async function loadUsers() {
    setLoading(true)
    try {
      setUsers(await getPropUsers())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to load Prop Trading users.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (isAdminUser()) void loadUsers(); else setLoading(false) }, [])

  function startNew() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowPassword(false)
    setNotice('')
  }

  function startEdit(user: PropUser) {
    setEditingId(user.id)
    setForm({ user_name: user.user_name, password: '', user_class: user.user_class.toLowerCase() === 'admin' ? 'Admin' : 'Staff', is_active: user.is_active })
    setShowPassword(false)
    setNotice('')
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setNotice('')
    const wasEditing = editingId !== null
    try {
      const saved = editingId === null ? await createPropUser(form) : await updatePropUser(editingId, form)
      setUsers((current) => editingId === null ? [...current, saved].sort((left, right) => left.user_name.localeCompare(right.user_name)) : current.map((user) => user.id === saved.id ? saved : user))
      startNew()
      setNotice(wasEditing ? 'Prop Trading user updated.' : 'Prop Trading user created.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to save Prop Trading user.')
    } finally {
      setSaving(false)
    }
  }

  if (!isAdminUser()) return <main className="page-wrap prop-users-page"><SectionHeader eyebrow="ACCESS MANAGEMENT" title="User management" description="Administrator access is required." /></main>

  return <main className="page-wrap prop-users-page">
    <SectionHeader eyebrow="PROP TRADING ENGINE · ACCESS MANAGEMENT" title="User management" description="Manage Prop Trading sign-ins and their workspace roles." />
    <div className="prop-users-layout">
      <section className="prop-users-card">
        <div className="prop-users-card-heading"><div><strong>Existing users</strong><span>Prop Trading access only</span></div><button className="prop-users-new" type="button" onClick={startNew}><Plus size={14} /> New user</button></div>
        <div className="prop-users-list" aria-live="polite">
          {loading ? <p className="prop-users-empty">Loading users…</p> : users.map((user) => <div className={`prop-user-row${editingId === user.id ? ' selected' : ''}`} key={user.id}>
            <div className="prop-user-avatar"><UserRound size={15} /></div><div className="prop-user-copy"><strong>{user.user_name}</strong><span>{user.user_class} · {user.is_active ? 'Active' : 'Inactive'}</span></div>
            <button className="prop-user-edit" type="button" aria-label={`Edit ${user.user_name}`} title={`Edit ${user.user_name}`} onClick={() => startEdit(user)}><Pencil size={14} /></button>
          </div>)}
          {!loading && users.length === 0 && <p className="prop-users-empty">No Prop Trading users found.</p>}
        </div>
      </section>
      <form className="prop-users-card prop-users-form" onSubmit={submit}>
        <div className="prop-users-form-heading"><div className="prop-users-form-icon"><ShieldCheck size={18} /></div><div><strong>{editingId === null ? 'New user' : 'Edit user'}</strong><span>Credentials stay private to Prop Trading.</span></div></div>
        <label><span>Username</span><div className="prop-users-input"><UserRound size={14} /><input value={form.user_name} onChange={(event) => setForm((current) => ({ ...current, user_name: event.target.value }))} autoComplete="off" required /></div></label>
        <label><span>Password {editingId !== null && <small>(leave blank to keep)</small>}</span><div className="prop-users-input"><ShieldCheck size={14} /><input value={form.password ?? ''} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} type={showPassword ? 'text' : 'password'} autoComplete="new-password" required={editingId === null} /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((current) => !current)}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
        <label><span>User class</span><select value={form.user_class} onChange={(event) => setForm((current) => ({ ...current, user_class: event.target.value as 'Admin' | 'Staff' }))}><option value="Staff">Staff</option><option value="Admin">Admin</option></select></label>
        <label className="prop-users-active"><input type="checkbox" checked={form.is_active} onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.checked }))} /> Active sign-in</label>
        {notice && <p className="prop-users-notice" role="status">{notice}</p>}
        <div className="prop-users-actions"><button className="prop-users-clear" type="button" onClick={startNew}>Clear</button><button className="btn primary" type="submit" disabled={saving}>{saving ? 'Saving…' : editingId === null ? 'Create user' : 'Save changes'}</button></div>
      </form>
    </div>
  </main>
}
