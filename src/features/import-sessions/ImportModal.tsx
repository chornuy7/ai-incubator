import { UploadCloud } from 'lucide-react'
import { Modal } from '@/shared/ui'

export function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Импортировать аккаунты"
      subtitle="Загрузка .session / tdata — в разработке"
      icon={<UploadCloud size={22} />}
      size="md"
    >
      <div className="rounded-xl border border-line bg-elevated p-4 text-sm text-muted">
        Импорт сессий будет подключён к TG API серверу. Сейчас добавляйте аккаунты через{' '}
        <span className="font-semibold text-fg">«Добавить аккаунт»</span> — номер телефона и реальная авторизация.
      </div>
      <button onClick={onClose} className="btn-primary mt-4 h-11 w-full">Понятно</button>
    </Modal>
  )
}
