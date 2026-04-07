// Functions for аутентификацией и авторизацией

// Update профиля user
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
        showNotification(data.message || 'Failed to update профиля', 'error');
        return;
      }
      
      const userData = await response.json();
      
      // Update дан user в состоянии
      appState.user = {
        ...appState.user,
        email: userData.email,
        fullName: userData.fullName
      };
      
      showNotification('Profile updated successfully', 'success');
    } catch (error) {
      console.error('Failed to update профиля:', error);
      showNotification('An error occurred при updatedии профиля', 'error');
    }
  }
  
  // Update пароля user
  async function handlePasswordUpdate(e) {
    e.preventDefault();
    
    const currentPassword = document.getElementById('settings-current-password').value;
    const newPassword = document.getElementById('settings-new-password').value;
    const confirmPassword = document.getElementById('settings-confirm-password').value;
    
    if (newPassword !== confirmPassword) {
      showNotification('Passwords do not match', 'error');
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
        showNotification(data.message || 'Failed to update пароля', 'error');
        return;
      }
      
      // Очистка fieldй forms
      document.getElementById('settings-current-password').value = '';
      document.getElementById('settings-new-password').value = '';
      document.getElementById('settings-confirm-password').value = '';
      
      showNotification('Password updated successfully', 'success');
    } catch (error) {
      console.error('Failed to update пароля:', error);
      showNotification('An error occurred при updatedии пароля', 'error');
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
      console.error('Error проверки токена:', error);
      return false;
    }
  }
  
  // Check permissions
  function hasPermission(permission) {
    // Can be extended for permission checking
    return appState.isAuthenticated;
  }