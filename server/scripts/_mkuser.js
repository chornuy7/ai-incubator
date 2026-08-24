import { createUser, updateUser } from '../users.js'
const email = `blocked_test_${Date.now()}@t.io`
const u = await createUser({ email, password: 'x12345', name: 'Тест Отключённый' })
await updateUser(u.id, { active: false })
console.log(u.id)
process.exit(0)
