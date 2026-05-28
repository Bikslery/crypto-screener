import { useState } from 'react'
import api from '../../services/api'
import { useAuthStore } from '../../store'

export function LoginForm() {
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login'
      const res = await api.post(endpoint, { email, password })
      login(res.data.token, res.data.user.email)
    } catch (err: any) {
      setError(err.response?.data?.error || 'Authentication failed')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
      <div className="w-full max-w-sm p-6 bg-[var(--bg-block)] border border-[var(--border)] rounded">
        <h1 className="text-xl font-bold text-center mb-6 text-[var(--fg)]">
          Crypto Screener
        </h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--primary)]"
              required
            />
          </div>
          <div>
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--primary)]"
              required
            />
          </div>
          {error && <div className="text-sm text-[var(--candle-down)]">{error}</div>}
          <button
            type="submit"
            className="w-full py-2 bg-[var(--primary)] text-white rounded font-medium hover:opacity-90"
          >
            {isRegister ? 'Register' : 'Login'}
          </button>
          <button
            type="button"
            className="w-full py-1 text-sm text-[var(--fg-50)] hover:text-[var(--fg)]"
            onClick={() => { setIsRegister(!isRegister); setError('') }}
          >
            {isRegister ? 'Already have an account? Login' : "Don't have an account? Register"}
          </button>
        </form>
      </div>
    </div>
  )
}
