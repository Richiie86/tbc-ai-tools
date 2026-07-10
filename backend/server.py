"""TBC AI Tools — FastAPI backend.

A comprehensive platform offering:
  • Multi-provider AI chat (Anthropic / OpenAI / Gemini / OpenRouter / Groq)
  • Real-time code collaboration
  • Automated deployment to Vercel
  • AI-powered code review & auto-fix
  • Payment processing (Stripe, NOWPayments, PayPal)
  • Referral system & notifications
  • Analytics & error monitoring

Architecture:
  - Async FastAPI with MongoDB (Motor)
  - JWT auth + bcrypt passwords
  - Multi-LLM routing with fallback chains
  - Server-Sent Events for real-time features
  - Vercel API integration for deployments
  - Redis rate limiting (Upstash)
  - Email via Resend
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from io import StringIO
from pathlib import Path
from typing import Optional

import bcrypt
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from jwt import PyJWT
from pydantic import BaseModel

# Framework setup
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('tbc')

# Load environment
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent / '.env'
    load_dotenv(env_path)
    logger.info(f'Environment loaded from {env_path}')
except ImportError:
    logger.info('python-dotenv not available, using system environment')

# Database
from db import db, client as db_client

# Core configuration
CORS_ORIGINS = os.environ.get('CORS_ORIGINS', '')
PRIMARY_DOMAIN = os.environ.get('PRIMARY_DOMAIN', '').strip()
JWT_SECRET = os.environ.get('JWT_SECRET')
OPERATOR_EMAIL = os.environ.get('OPERATOR_EMAIL')
OPERATOR_PASSWORD = os.environ.get('OPERATOR_PASSWORD')

if not JWT_SECRET:
    raise RuntimeError('JWT_SECRET environment variable is required')
if not OPERATOR_EMAIL or not OPERATOR_PASSWORD:
    raise RuntimeError('OPERATOR_EMAIL and OPERATOR_PASSWORD are required')

# Model configuration
DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'

MANDATORY_SYSTEM_PROMPT = (
    "You are an expert AI assistant built into TBC AI Tools. You provide helpful, "
    "accurate, and concise responses while maintaining a professional yet friendly tone. "
    "When appropriate, suggest using the platform's built-in tools like Deploy, "
    "Code Review, or domain management instead of giving generic tutorials."
)

MODEL_PROVIDERS = {
    # Anthropic models
    'claude-sonnet-4-5-20250929': 'anthropic',
    'claude-haiku-4-5-20251001': 'anthropic',
    'claude-opus-3-5': 'anthropic',
    
    # OpenAI models  
    'gpt-4.1': 'openai',
    'gpt-4o': 'openai',
    'gpt-4o-mini': 'openai',
    'o1-preview': 'openai',
    'o1-mini': 'openai',
    
    # Gemini models
    'gemini-2.5-pro': 'gemini',
    'gemini-2.5-flash': 'gemini',
    'gemini-2.5-flash-8b': 'gemini',
    
    # OpenRouter models
    'anthropic/claude-sonnet-4': 'openrouter',
    'openai/gpt-4o-mini': 'openrouter',
    'google/gemini-2.5-flash': 'openrouter',
    'meta-llama/llama-3.3-70b-instruct': 'openrouter',
    'qwen/qwen-2.5-coder-32b-instruct': 'openrouter',
    'deepseek/deepseek-r1': 'openrouter',
    'x-ai/grok-2': 'openrouter',
    
    # Groq models
    'llama-3.3-70b-versatile': 'groq',
    'gemma2-9b-it': 'groq',
    'mixtral-8x7b-32768': 'groq',
    
    # Auto routing
    'auto': 'auto',
}

# System prompts
SYSTEM_PROMPT = MANDATORY_SYSTEM_PROMPT
CORE_KNOWLEDGE = """

### CORE KNOWLEDGE
This is TBC AI Tools, a comprehensive platform providing AI-powered development tools:

**Key Features:**
• Multi-provider AI chat (you're one of them!)
• Real-time collaborative coding
• One-click Vercel deployments with custom domains
• AI code review with auto-fix capabilities
• Comprehensive error monitoring and debugging
• Payment processing and subscription management
• Built-in analytics and user management

**Available Models:**
Users can choose from Claude (Anthropic), GPT (OpenAI), Gemini (Google), OpenRouter models, and Groq for different use cases.

**When Users Ask About:**
- Deployment → Point them to the Deploy button (don't write Vercel tutorials)
- Domains → Mention the domain management in the Ops tab
- Errors → Suggest using the runtime error monitoring
- Payments → Reference the built-in Stripe/crypto payment system
- Collaboration → Highlight the real-time code sharing features

Be helpful and accurate, but always prefer directing users to the platform's built-in tools over generic solutions.
"""

# Auth utilities
jwt_handler = PyJWT()

def hash_password(password: str) -> str:
    """Hash a password with bcrypt."""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash."""
    try:
        return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False

def create_jwt_token(user_data: dict) -> str:
    """Create a JWT token for a user."""
    payload = {
        'sub': user_data['id'],
        'email': user_data['email'],
        'role': user_data.get('role', 'user'),
        'exp': datetime.now(timezone.utc) + timedelta(days=30),
        'iat': datetime.now(timezone.utc)
    }
    return jwt_handler.encode(payload, JWT_SECRET, algorithm='HS256')

def verify_jwt_token(token: str) -> Optional[dict]:
    """Verify and decode a JWT token."""
    try:
        payload = jwt_handler.decode(token, JWT_SECRET, algorithms=['HS256'])
        return payload
    except Exception:
        return None

# Startup tasks
async def ensure_operator_account():
    """Ensure the operator account exists on startup."""
    try:
        existing = await db.users.find_one({'email': OPERATOR_EMAIL})
        if not existing:
            operator_doc = {
                'id': str(uuid.uuid4()),
                'email': OPERATOR_EMAIL,
                'password_hash': hash_password(OPERATOR_PASSWORD),
                'role': 'operator',
                'credits': -1,  # Unlimited
                'plan': 'operator',
                'created_at': datetime.now(timezone.utc),
                'updated_at': datetime.now(timezone.utc),
            }
            await db.users.insert_one(operator_doc)
            logger.info(f'Created operator account for {OPERATOR_EMAIL}')
        else:
            logger.info(f'Operator account exists for {OPERATOR_EMAIL}')
    except Exception as e:
        logger.error(f'Failed to ensure operator account: {e}')

async def setup_cors_origins():
    """Initialize CORS origin management."""
    try:
        from cors_dynamic_ext import start_cors_refresher
        await start_cors_refresher()
        logger.info('CORS dynamic origin management initialized')
    except Exception as e:
        logger.warning(f'CORS setup failed: {e}')

async def setup_database_indexes():
    """Create necessary database indexes."""
    try:
        # User indexes
        await db.users.create_index('email', unique=True)
        await db.users.create_index('id', unique=True)
        
        # Chat indexes
        await db.chat_sessions.create_index([('user_id', 1), ('created_at', -1)])
        await db.chat_messages.create_index([('session_id', 1), ('created_at', 1)])
        
        # Error tracking
        await db.runtime_errors.create_index([('created_at', -1)])
        await db.runtime_errors.create_index([('severity', 1)])
        
        # Notifications
        await db.user_notifications.create_index([('user_id', 1), ('created_at', -1)])
        
        logger.info('Database indexes created successfully')
    except Exception as e:
        logger.warning(f'Index creation failed: {e}')

# Application lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle."""
    logger.info('Starting TBC AI Tools backend...')
    
    # Startup tasks
    await ensure_operator_account()
    await setup_cors_origins()
    await setup_database_indexes()
    
    # Start scheduled tasks
    scheduler = AsyncIOScheduler()
    
    # Start birthday rewards loop
    try:
        from birthday_ext import birthday_scheduler_loop
        asyncio.create_task(birthday_scheduler_loop())
        logger.info('Birthday scheduler started')
    except Exception as e:
        logger.warning(f'Birthday scheduler failed to start: {e}')
    
    # Start alerts loop  
    try:
        from alerts_ext import alerts_scheduler_loop
        asyncio.create_task(alerts_scheduler_loop())
        logger.info('Alerts scheduler started')
    except Exception as e:
        logger.warning(f'Alerts scheduler failed to start: {e}')
    
    # APScheduler for periodic tasks
    try:
        # Auto-withdraw (hourly)
        from autowithdraw_ext import run_auto_withdraw_once
        scheduler.add_job(
            run_auto_withdraw_once,
            'interval',
            hours=1,
            id='auto_withdraw',
            replace_existing=True
        )
        
        # Auto-fix loop (every 5 minutes)
        from auto_fix_loop_ext import run_auto_fix_tick
        scheduler.add_job(
            run_auto_fix_tick,
            'interval',
            minutes=5,
            id='auto_fix_loop',
            replace_existing=True
        )
        
        # AI test bench drift alerts (nightly at 2 AM UTC)
        from ai_test_bench_ext import _nightly_drift_alert
        scheduler.add_job(
            _nightly_drift_alert,
            'cron',
            hour=2,
            minute=0,
            id='ai_drift_alerts',
            replace_existing=True
        )
        
        # BYOK billing (daily at 3 AM UTC)
        from byok_ext import run_byok_billing_pass
        scheduler.add_job(
            run_byok_billing_pass,
            'cron',
            hour=3,
            minute=0,
            id='byok_billing',
            replace_existing=True
        )
        
        # Auto-learning garbage collection (weekly on Sundays at 4 AM UTC)
        from ai_learnings_ext import archive_stale_proposals
        scheduler.add_job(
            archive_stale_proposals,
            'cron',
            day_of_week=6,  # Sunday
            hour=4,
            minute=0,
            id='learning_gc',
            replace_existing=True
        )
        
        scheduler.start()
        logger.info('APScheduler started with periodic tasks')
    except Exception as e:
        logger.warning(f'Scheduler setup failed: {e}')
    
    logger.info('TBC AI Tools backend startup complete')
    
    yield
    
    # Shutdown
    logger.info('Shutting down TBC AI Tools backend...')
    try:
        scheduler.shutdown(wait=False)
        db_client.close()
        logger.info('Shutdown complete')
    except Exception as e:
        logger.error(f'Shutdown error: {e}')

# Create FastAPI app
app = FastAPI(
    title="TBC AI Tools API",
    description="Comprehensive AI-powered development platform",
    version="1.0.0",
    lifespan=lifespan
)

# CORS configuration
if CORS_ORIGINS == '*':
    app.add_middleware(
        CORSMiddleware,
        allow_origins=['*'],
        allow_credentials=False,
        allow_methods=['*'],
        allow_headers=['*'],
    )
else:
    # Dynamic CORS with database-backed origins
    try:
        from cors_dynamic_ext import DynamicOriginCORSMiddleware
        
        # Build static origins from env and primary domain
        origins = []
        if CORS_ORIGINS:
            origins.extend(o.strip() for o in CORS_ORIGINS.split(',') if o.strip())
        
        # Always trust tbctools.org and PRIMARY_DOMAIN
        origins.extend([
            'https://tbctools.org',
            'https://www.tbctools.org',
        ])
        if PRIMARY_DOMAIN:
            origins.extend([
                f'https://{PRIMARY_DOMAIN}',
                f'http://{PRIMARY_DOMAIN}',  # for local dev
            ])
        
        # Remove duplicates while preserving order
        seen = set()
        unique_origins = []
        for origin in origins:
            if origin not in seen:
                unique_origins.append(origin)
                seen.add(origin)
        
        app.add_middleware(
            DynamicOriginCORSMiddleware,
            allow_origins=unique_origins,
            allow_credentials=True,
            allow_methods=['*'],
            allow_headers=['*'],
        )
    except Exception as e:
        logger.warning(f'Dynamic CORS setup failed, falling back to basic: {e}')
        app.add_middleware(
            CORSMiddleware,
            allow_origins=['https://tbctools.org'],
            allow_credentials=True,
            allow_methods=['*'],
            allow_headers=['*'],
        )

# Static files
try:
    static_path = Path(__file__).parent / 'static'
    if static_path.exists():
        app.mount('/static', StaticFiles(directory=static_path), name='static')
except Exception as e:
    logger.warning(f'Static files setup failed: {e}')

# Basic health check
@app.get('/health')
async def health_check():
    """Basic health check endpoint."""
    try:
        # Test database connection
        await db.users.count_documents({}, limit=1)
        return {
            'status': 'healthy',
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'version': '1.0.0'
        }
    except Exception as e:
        raise HTTPException(status_code=503, detail=f'Database connection failed: {str(e)}')

# Public system info
@app.get('/api/system/info')
async def system_info():
    """Public system information."""
    return {
        'name': 'TBC AI Tools',
        'version': '1.0.0',
        'available_models': list(MODEL_PROVIDERS.keys()),
        'features': [
            'Multi-provider AI chat',
            'Code collaboration',
            'Automated deployments', 
            'AI code review',
            'Error monitoring',
            'Payment processing'
        ]
    }

# Route registration
def setup_routers():
    """Register all API routers."""
    try:
        # Core authentication and user management
        from auth_ext import router as auth_router
        app.include_router(auth_router)
        
        # Chat and messaging
        from chat_ext import router as chat_router
        app.include_router(chat_router)
        
        # Deploy and project management
        from deploy_projects_ext import setup_routers as setup_deploy_routers
        setup_deploy_routers(app)
        
        # AI and learning systems
        from ai_learnings_ext import router as ai_learnings_router
        app.include_router(ai_learnings_router)
        
        from ai_brain_ext import router as ai_brain_router
        app.include_router(ai_brain_router)
        
        from ai_build_ext import router as ai_build_router
        app.include_router(ai_build_router)
        
        from ai_test_bench_ext import router as ai_test_router
        app.include_router(ai_test_router)
        
        from ai_visual_verify_ext import router as ai_visual_router
        app.include_router(ai_visual_router)
        
        # Payment and billing
        from payments_ext import router as payments_router
        app.include_router(payments_router)
        
        from billing_portal_ext import router as billing_router
        app.include_router(billing_router)
        
        from autowithdraw_ext import router as withdraw_router
        app.include_router(withdraw_router)
        
        # User features
        from notifications_ext import router as notifications_router
        app.include_router(notifications_router)
        
        from referrals_ext import router as referrals_router
        app.include_router(referrals_router)
        
        from sandbox_ai_ext import router as sandbox_router
        app.include_router(sandbox_router)
        
        from domain_launch_ext import router as domain_router
        app.include_router(domain_router)
        
        # Analytics and monitoring
        from runtime_errors_ext import router as errors_router
        app.include_router(errors_router)
        
        from analytics_ext import router as analytics_router
        app.include_router(analytics_router)
        
        from alerts_ext import router as alerts_router
        app.include_router(alerts_router)
        
        # Admin and operator tools
        from audit_ext import router as audit_router
        app.include_router(audit_router)
        
        from users_ext import router as users_router
        app.include_router(users_router)
        
        from cors_dynamic_ext import router as cors_router
        app.include_router(cors_router)
        
        # App management
        from app_settings_ext import public_router as app_public_router
        from app_settings_ext import op_router as app_op_router
        app.include_router(app_public_router)
        app.include_router(app_op_router)
        
        from changelog_ext import router as changelog_router
        app.include_router(changelog_router)
        
        # Additional features
        from birthday_ext import router as birthday_router
        app.include_router(birthday_router)
        
        from byok_ext import router as byok_router
        app.include_router(byok_router)
        
        from auto_fix_loop_ext import router as auto_fix_router
        app.include_router(auto_fix_router)
        
        from app_builder_ext import operator_router as app_builder_op_router
        from app_builder_ext import agent_router as app_builder_agent_router
        app.include_router(app_builder_op_router)
        app.include_router(app_builder_agent_router)
        
        from chat_deploy_ext import router as chat_deploy_router
        app.include_router(chat_deploy_router)
        
        from amai_ext import router as amai_router
        app.include_router(amai_router)
        
        from context7_ext import router as context7_router
        app.include_router(context7_router)
        
        from ai_build_tests_ext import router as build_tests_router
        app.include_router(build_tests_router)
        
        logger.info('All routers registered successfully')
        
    except Exception as e:
        logger.error(f'Router setup failed: {e}')
        raise

# Initialize routers
setup_routers()

# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Log and handle unexpected exceptions."""
    logger.exception(f'Unhandled exception on {request.method} {request.url}: {exc}')
    return HTTPException(
        status_code=500,
        detail='An internal server error occurred. The issue has been logged.'
    )

# Development server
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(
        'server:app',
        host='0.0.0.0',
        port=int(os.environ.get('PORT', 8000)),
        reload=True,
        log_level='info'
    )
