class ApiClient {
  constructor(baseURL = '/api') {
    this.baseURL = baseURL;
  }

  getHeaders() {
    const token = localStorage.getItem('token');
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    return headers;
  }

  async handleUnauthorized() {
    const refreshToken = localStorage.getItem('refreshToken');
    
    if (refreshToken) {
      try {
        const response = await fetch(`/api/auth-security/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });

        if (response.ok) {
          const data = await response.json();
          localStorage.setItem('token', data.token);
          if (data.refreshToken) {
            localStorage.setItem('refreshToken', data.refreshToken);
          }
          return true;
        }
      } catch (error) {
        console.error('Refresh token failed:', error);
      }
    }
    
    localStorage.clear();
    window.location.href = '/';
    return false;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const config = {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...options.headers,
      },
    };

    if (options.body && typeof options.body === 'object') {
      config.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, config);
      
      if (response.status === 401) {
        const refreshed = await this.handleUnauthorized();
        if (refreshed) {
          const retryConfig = {
            ...config,
            headers: {
              ...config.headers,
              ...this.getHeaders()
            }
          };
          const retryResponse = await fetch(url, retryConfig);
          const retryData = await retryResponse.json();
          
          if (!retryResponse.ok) {
            const error = new Error(retryData.message || retryData.error || 'Erreur API');
            error.status = retryResponse.status;
            throw error;
          }
          
          return retryData;
        }
        throw new Error('Session expirée');
      }
      
      const data = await response.json();
      
      if (!response.ok) {
        const error = new Error(data.message || data.error || 'Erreur API');
        error.status = response.status;
        throw error;
      }
      
      return data;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  }

  async get(endpoint, params = {}) {
    const queryParams = new URLSearchParams(params);
    const queryString = queryParams.toString();
    return this.request(queryString ? `${endpoint}?${queryString}` : endpoint, { method: 'GET' });
  }

  async post(endpoint, data = {}, options = {}) {
    return this.request(endpoint, {
      method: 'POST',
      body: data,
      ...options,
    });
  }

  async put(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'PUT',
      body: data,
    });
  }

  async delete(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'DELETE',
      body: data,
    });
  }
}

export const api = new ApiClient();
export default api;
