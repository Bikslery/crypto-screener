import axios from 'axios'
import { useAuthStore } from '../store'

const api = axios.create({
  baseURL: '/api',
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(null, (error) => {
  if (error.response?.status === 401) {
    useAuthStore.getState().logout()
  }
  return Promise.reject(error)
})

export default api
