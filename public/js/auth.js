// Функции для работы с аутентификацией и авторизацией

// Обновление профиля пользователя
async function handleProfileUpdate(e) {
    e.preventDefault();
    
    const email = document.getElementById('settings-email').value;
    const fullName = document.getElementById('settings-fullname').value;
    
    try {
      const response = await fetchWithAuth('/api/auth/me', {
        method: 'PUT',
        body: JSON.stringify({ email, fullName })
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || t('auth.profile.updateError'), 'error');
        return;
      }
      
      const userData = await response.json();
      
      // Обновление данных пользователя в состоянии
      appState.user = {
        ...appState.user,
        email: userData.email,
        fullName: userData.fullName
      };
      
      showNotification(t('auth.profile.updated'), 'success');
    } catch (error) {
      console.error('Ошибка обновления профиля:', error);
      showNotification(t('auth.profile.updateFailed'), 'error');
    }
  }
  
  // Обновление пароля пользователя
  async function handlePasswordUpdate(e) {
    e.preventDefault();
    
    const currentPassword = document.getElementById('settings-current-password').value;
    const newPassword = document.getElementById('settings-new-password').value;
    const confirmPassword = document.getElementById('settings-confirm-password').value;
    
    if (newPassword !== confirmPassword) {
      showNotification(t('auth.password.mismatch'), 'error');
      return;
    }
    
    try {
      const response = await fetchWithAuth('/api/auth/me', {
        method: 'PUT',
        body: JSON.stringify({
          currentPassword,
          password: newPassword
        })
      });
      
      if (!response.ok) {
        const data = await response.json();
        showNotification(data.message || t('auth.password.updateError'), 'error');
        return;
      }
      
      // Сервер отзывает старые токены при смене пароля и отдаёт новый.
      const updated = await response.json().catch(() => ({}));
      if (updated && updated.token) localStorage.setItem('token', updated.token);

      // Очистка полей формы
      document.getElementById('settings-current-password').value = '';
      document.getElementById('settings-new-password').value = '';
      document.getElementById('settings-confirm-password').value = '';
      
      showNotification(t('auth.password.updated'), 'success');
    } catch (error) {
      console.error('Ошибка обновления пароля:', error);
      showNotification(t('auth.password.updateFailed'), 'error');
    }
  }
  
  // Проверка токена
  async function validateToken() {
    const token = localStorage.getItem('token');
    
    if (!token) {
      return false;
    }
    
    try {
      const response = await fetch('/api/auth/validate', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      return response.ok;
    } catch (error) {
      console.error('Ошибка проверки токена:', error);
      return false;
    }
  }
  
  // Проверка прав доступа
  function hasPermission(permission) {
    // В будущем можно расширить для проверки прав доступа
    return appState.isAuthenticated;
  }