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
        showNotification(data.message || 'Ошибка обновления профиля', 'error');
        return;
      }
      
      const userData = await response.json();
      
      // Обновление данных пользователя в состоянии
      appState.user = {
        ...appState.user,
        email: userData.email,
        fullName: userData.fullName
      };
      
      showNotification('Профиль успешно обновлен', 'success');
    } catch (error) {
      console.error('Ошибка обновления профиля:', error);
      showNotification('Произошла ошибка при обновлении профиля', 'error');
    }
  }
  
  // Обновление пароля пользователя
  async function handlePasswordUpdate(e) {
    e.preventDefault();
    
    const currentPassword = document.getElementById('settings-current-password').value;
    const newPassword = document.getElementById('settings-new-password').value;
    const confirmPassword = document.getElementById('settings-confirm-password').value;
    
    if (newPassword !== confirmPassword) {
      showNotification('Пароли не совпадают', 'error');
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
        showNotification(data.message || 'Ошибка обновления пароля', 'error');
        return;
      }
      
      // Очистка полей формы
      document.getElementById('settings-current-password').value = '';
      document.getElementById('settings-new-password').value = '';
      document.getElementById('settings-confirm-password').value = '';
      
      showNotification('Пароль успешно обновлен', 'success');
    } catch (error) {
      console.error('Ошибка обновления пароля:', error);
      showNotification('Произошла ошибка при обновлении пароля', 'error');
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