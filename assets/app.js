/* Chaves de Cache Gloabis:
	$rateLimit

Configurações do cache
*/

var _cacheLimitSize = 10000; // Quantidade de objetos máxima
var _cacheLimitTime = 600000; // 10min
var _cacheState = 0; // Cursor
var _cacheRef = {}; // Armazenamento dos valores propriamente ditos
var _cachePos = []; // Apenas garante que o total não exceda o limite
var _cacheTime = {}; // Guarda tempo de inserção no cache p/ posterior checagem de expiração
var _cacheAllowEvict = true; // Mutex que controla acesso à função de expiração; se falso aguarda próximo ciclo

/* Tipos */

// Data pré-formatada
function BrDate(...args) {
	var br = new (Function.prototype.bind.apply(Date, [Date].concat(Array.prototype.slice.call(args))));
	br.__proto__ = BrDate.prototype;
	return br;
}
BrDate.prototype.__proto__ = Date.prototype;

BrDate.prototype.toString = function(format = 'full') {
	let dd = this.getDate().toString().padStart(2, '0');
	let MM = (this.getMonth()+1).toString().padStart(2, '0');
	let yyyy = this.getFullYear().toString();
	let hh = this.getHours().toString().padStart(2, '0');;
	let mm = this.getMinutes().toString().padStart(2, '0');;
	let ss = this.getSeconds().toString().padStart(2, '0');;
	switch(format) {
		case 'date':
			return `${dd}/${MM}/${yyyy}`;
		case 'time':
			return `${hh}:${mm}:${ss}`;
		default:
			return `${dd}/${MM}/${yyyy} ${hh}:${mm}:${ss}`;
	}
};

// String polyfill
if (!String.prototype.padStart) {
    String.prototype.padStart = function padStart(targetLength,padString) {
        targetLength = targetLength>>0; //truncate if number or convert non-number to 0;
        padString = String((typeof padString !== 'undefined' ? padString : ' '));
        if (this.length > targetLength) {
            return String(this);
        }
        else {
            targetLength = targetLength-this.length;
            if (targetLength > padString.length) {
                padString += padString.repeat(targetLength/padString.length); //append to original to ensure we are longer than needed
            }
            return padString.slice(0,targetLength) + String(this);
        }
    };
}

/* Biblioteca de módulos */

// Módulo de utilitários
var moduleUtil = (function() {

	/* https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/getAllResponseHeaders */
	function _extractHeaders(xhr) {
		let headerMap = {};
		let headers, arr, parts, header, value;
		if(xhr && typeof xhr.getAllResponseHeaders === 'function') {
			headers = xhr.getAllResponseHeaders();
			arr = headers.trim().split(/[\r\n]+/);
			arr.forEach(function (line) {
				parts = line.split(': ');
				header = parts.shift();
				value = parts.join(': ');
				headerMap[header.toLowerCase()] = value;
			});
		}
		return headerMap;
	}

	function _extractResponse(xhr) {
		try {
			return xhr.responseText ? JSON.parse(xhr.responseText) : null;
		} catch(e) {
			return xhr.responseText;
		}
	}

	function _get(url, timeout, onTimeout) {
		return new Promise(function(resolve, reject) {
			let xhr = new XMLHttpRequest();
			let _readResponse = (xhr)  => {
				return {
					status: xhr.status,
					headers: _extractHeaders(xhr),
					data: _extractResponse(xhr),
					config: {
						url: url,
						body: null
					}
				};
			};
			let _handleTimeout = () => {
				if(typeof onTimeout === 'function') {
					onTimeout();
				}
				return {
					status: -1,
					responseText: 'Timeout Error'
				};
			}

			xhr.open('GET', url);

			xhr.onload = function() {
				switch(xhr.status) {
					case 200:
						resolve(_readResponse(xhr));
						break;
					case 408:
					case 504:
						reject(_handleTimeout());
						break;
					default:
						reject(_readResponse(xhr));
				}
			};

			xhr.onerror = function() {
				reject(_handleTimeout());
			};

			xhr.timeout = timeout;
			xhr.ontimeout = function () {
				reject(_handleTimeout());
			};

			xhr.send();
		});
	}

	/**
	Executa requisição retornando promise(sucesso, erro)
	*/
	function doGet(urlBase, data, timeoutCallback) {
		var url = urlBase;
		var urlPairs = [];
		var name;

		if(data) {
			url += '?';
			for(name in data) {
				urlPairs.push(encodeURIComponent(name) + '=' + encodeURIComponent(data[name]));
			}
			url = url + urlPairs.join('&').replace(/%20/g, '+');
		}
		return _get(url, 2000, timeoutCallback);
	}

	function defaultErrorHandler() {
		return (result) => {
			moduleView.showError(result.data);
			console.error(result);
		};
	}
	
	/* https://davidwalsh.name/javascript-debounce-function */
	function debounce(func, wait, immediate) {
		let timeout;
		return function() {
			let context = this, args = arguments;
			let later = function() {
				timeout = null;
				if (!immediate) func.apply(context, args);
			};
			let callNow = immediate && !timeout;
			clearTimeout(timeout);
			timeout = setTimeout(later, wait);
			if (callNow) func.apply(context, args);
		};
	}

	/*
	Realiza limpeza do cache por idade
	*/
	function evictCache() {
		let evictCount = 0;
		if(_cacheAllowEvict) {
			_cacheAllowEvict = false;
			Object.keys(_cacheTime).forEach(function(key) {
				if(key && Number.isInteger(_cacheTime[key]) && Date.now() >= (_cacheTime[key] + _cacheLimitTime)) {
					delete _cacheTime[key];
					delete _cacheRef[key];
					evictCount++;
				}
			});
			_cacheAllowEvict = true;
			if(evictCount > 0) {
				console.log(`[evictCache]: ${evictCount} entrada(s) removida(s) do cache em ${new BrDate()}`);
			}
		}
		return _cacheAllowEvict;
	}

	/*
	Adiciona conteúdo no cache, sobreescrevendo quando atinge a quantidade limite
	*/
	function putCache(key, value) {
		if(typeof key !== 'string' || isNullOrUndefined(value)) {
			return;
		}
		if(!(_cacheState < _cacheLimitSize)) {
			_cacheState = 0;
		}
		if(!isNullOrUndefined(_cachePos[_cacheState])) {
			delete _cacheTime[_cachePos[_cacheState]];
			delete _cacheRef[_cachePos[_cacheState]];
		}
		_cachePos[_cacheState++] = key;
		_cacheRef[key] = value;
		_cacheTime[key] = Date.now();
	}

	/*
	Obtém conteúdo do cache, caso exista. Do  contrário retorna undefined
	*/
	function getCache(key) {
		return _cacheRef[key];
	}

	/*
	Limpa o estado do cache
	function clearCache() {
		_cacheState = 0;
		_cacheRef = {};
		_cachePos = [];
		_cacheTime = {};
	}
	*/

	/*
	Testa se valor é null ou undefined
	*/
	function isNullOrUndefined(value) {
		return value === null || value === undefined;
	}

	return {
		doGet: doGet,
		defaultErrorHandler: defaultErrorHandler,
		debounce: debounce,
		evictCache: evictCache,
		putCache: putCache,
		getCache: getCache,
		//clearCache: clearCache,
		isNullOrUndefined: isNullOrUndefined
	};
	// Fim -  moduleUtil
})();

// Módulo de interação com GitHub
var moduleGithub = (function() {

	/*
	[Promise]: Atualiza o cache com o objeto que represeta o rate_limit do github
	*/
	function refreshRateLimit() {
		return moduleUtil.doGet('https://api.github.com/rate_limit')
			.then(function(result) {
				// Atualiza o cache
				moduleUtil.putCache('$rateLimit', result.data);
			}).catch(moduleUtil.defaultErrorHandler());
	}

	/*
	[Promise]: Obtém lista de usuários
	*/
	function searchUsers(fullnameKey) {
		let searchUrl = `https://api.github.com/search/users?q=${fullnameKey}+in:fullname`;
		let cachedResult = moduleUtil.getCache(fullnameKey);
		// Caso exista no cache, utiliza
		if(!moduleUtil.isNullOrUndefined(cachedResult)) {
			console.log(`Usando cache p/ "${fullnameKey}"`);
			return new Promise(function(resolve, reject) {
				resolve({
					status: 200,
					data: cachedResult,
					config: {
						url: searchUrl,
						body: null
					}
				});
			});
		}
		console.log(`Pequisando nova entrada "${fullnameKey}"`);
		let _searchSuccess = () => {
			return function(result) {
				if(result.data.total_count > 0) {
					// Salva no cache
					moduleUtil.putCache(fullnameKey, result.data);
				}
				// Retorna p/ uso na promise seguinte
				return result;
			};
		};
		let _searchError = () => {
			return function(error) {
				let msgGeneric = '* Erro desconhecido ao executar a pesquisa';
				switch(error.status) {
					case  0:
						//Abortado
						moduleView.showSearchError('* Ação abortada pelo usuário');
						break;
					case -1:
						//Timeout
						moduleView.showSearchError('* Conexão perdida');
						break;
					case 403:
						// RateLimit, provavelmente
						let rateLimit = moduleGithub.parseRateLimitHeaders(error);

						if(moduleUtil.isNullOrUndefined(rateLimit.limit)) {
							moduleView.showSearchError(msgGeneric);
						} else {
							moduleView.showSearchError(`* Não é possível realizar novas buscas. Tente novamente em ${rateLimit.reset}`);
						}
						break;
					default:
						//Erro genérico
						moduleView.showSearchError(msgGeneric);
				}
				// Encaminha erro para cada superior
				return Promise.reject(error);
			};
		};
		return moduleUtil.doGet(searchUrl)
			.then(_searchSuccess()).catch(_searchError());
	}

	function parseRateLimitHeaders(response) {
		return {
			limit: moduleUtil.isNullOrUndefined(response.headers['x-ratelimit-limit']) ? undefined : parseInt(response.headers['x-ratelimit-limit']),
			remaining: moduleUtil.isNullOrUndefined(response.headers['x-ratelimit-remaining']) ? undefined : parseInt(response.headers['x-ratelimit-remaining']),
			reset: moduleUtil.isNullOrUndefined(response.headers['x-ratelimit-reset']) ? undefined : new BrDate(parseInt(response.headers['x-ratelimit-reset']) * 1000)
		}
	}

	return {
		parseRateLimitHeaders: parseRateLimitHeaders,
		refreshRateLimit: refreshRateLimit,
		searchUsers: searchUsers
	};
	// Fim -  moduleGithub
})();

// Módulo de interação com Usuário
var moduleView = (function() {
	function showSearchError(msg) {
		var errorElem = document.querySelector('#search-result > div.error');
		errorElem.innerHTML = msg;
		return errorElem;
	}

	function _clearSearchError() {
		showSearchError(null);
	}

	function showFriendError(msg) {
		var errorElem = document.querySelector('#friends > div.error');
		errorElem.innerHTML = msg;
		return errorElem;
	}

	function _clearFriendError() {
		showFriendError(null);
	}

	function showError(msg) {
		alert(msg);
	}

	function _clearAllErrors() {
		_clearSearchError();
		_clearFriendError();
	}

	function showSearchResults(data) {
		let ul = document.querySelector('ul#result-items');
		let liArray = ul.querySelectorAll('li.result-item');
		let liEmpty = document.querySelector('li#result-empty');
		ul.style.display = 'block';
		for(let i = 0; i < 10; i++) {
			liArray[i].innerHTML = (data.items[i] || {}).login || null;
		}
		if(data.total_count === 0) {
			liEmpty.style.display = 'block';
			console.log('Nenhum resultado encontrado');
		} else {
			liEmpty.style.display = 'none';
			console.log(`${data.total_count} resultado(s) encontrado(s)`);
		}
	}

	function _clearSearchResults() {
		let ul = document.querySelector('ul#result-items');
		ul.style.display = 'none';
	}

	function doSearch(e) {
		let inputValue = (e.target || {}).value;
		let validation = () => {
			// Não pesquisa vazio ou apenas 1 caractér
			if(!inputValue || inputValue.length < 2) {
				console.log('Não pesquisa vazio ou apenas 1 caractér');
				return { success: false };
			}
			// Não pesquisa caracter de controle ou > <
			if(inputValue.match(/[\x00-\x1F\x3C\x3E\x7F]+/g) !== null) {
				// Limpa do imput os caractéres inválidos
				inputValue = inputValue.replace(/[\x00-\x1F\x3C\x3E\x7F]+/g, '');
				e.target.value = inputValue;
				e.target.focus(); // Força renderização
				console.log('Não pesquisa caracter de controle ou > <');
			}
			return { success: true };
		};
		// Executa validação, limpa mensagens de erro e executa pesquisa, caso a valide com sucesso
		let isValid = validation().success;
		_clearAllErrors();
		if(isValid) {
			moduleGithub.searchUsers(inputValue)
				.then((result) => {
					showSearchResults(result.data);
				}).catch((error) => {
					_clearSearchResults();
				});
		}
	}

	return {
		showSearchError: showSearchError,
		showFriendError: showFriendError,
		showError: showError,
		//clearSearchError: clearSearchError,
		//clearFriendError: clearFriendError,
		//clearAllErrors: clearAllErrors,
		doSearch: doSearch,
	};
	// Fim -  moduleView
})();

/* Recursos ok */

window.addEventListener('load', function() {
	// A cada 30 segundos, percorre o cache e realiza a limpeza necessária
	window.setInterval(moduleUtil.evictCache, 30000);

	// Configuração dos eventos
	let input = document.querySelector('input#keyword');
	let form = document.querySelector('form#search');
	form.addEventListener("submit", function (event) {
		event.preventDefault();
		moduleUtil.debounce(() => moduleView.doSearch({ target: input }), 275)();
	});

	input.addEventListener("keyup", moduleUtil.debounce((event) => moduleView.doSearch(event), 275));

	// Testes/Debug
	var p = moduleGithub.refreshRateLimit(); //TODO: usar p/ alguma coisa
	/*p.then(() => {
		moduleGithub.searchUsers('%2B%20%2D%20%2E%20%3D%20%26%26%20%7C%7C%20%21%20%28%20%29%20%7B%20%7D%20%5B%20%5D%20%5E%20%22%20%7E%20%2A%20%3F%20%3A%20%5C%20%2F').catch((error) => {
			alert(error.data);
		});
	});*/
});
