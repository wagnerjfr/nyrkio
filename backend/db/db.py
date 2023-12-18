# Copyright (c) 2024, Nyrkiö Oy

from abc import abstractmethod, ABC
import os
from typing import Dict, List

import motor.motor_asyncio
from mongomock_motor import AsyncMongoMockClient
from beanie import Document, PydanticObjectId, init_beanie
from fastapi_users.db import BaseOAuthAccount, BeanieBaseUser, BeanieUserDatabase
from fastapi_users import schemas
from pydantic import Field

fake_users_db = {
    "johndoe": {
        "username": "johndoe",
        "full_name": "John Doe",
        "email": "johndoe@example.com",
        "hashed_password": "$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW",  # noqa: E501
        "disabled": False,
        "is_admin": False,
    }
}


class OAuthAccount(BaseOAuthAccount):
    pass


class User(BeanieBaseUser, Document):
    oauth_accounts: List[OAuthAccount] = Field(default_factory=list)


async def get_user_db():
    yield BeanieUserDatabase(User, OAuthAccount)


class UserRead(schemas.BaseUser[PydanticObjectId]):
    pass


class UserCreate(schemas.BaseUserCreate):
    pass


class UserUpdate(schemas.BaseUserUpdate):
    pass


class ConnectionStrategy(ABC):
    @abstractmethod
    def connect(self):
        pass

    def init_db(self):
        pass


class MongoDBStrategy(ConnectionStrategy):
    """
    Connect to a production MongoDB.
    """

    def connect(self):
        db_user = os.environ.get("DB_USER", None)
        db_password = os.environ.get("DB_PASSWORD", None)
        db_name = os.environ.get("DB_NAME", None)

        url = f"mongodb+srv://{db_user}:{db_password}@prod0.dn3tizr.mongodb.net/?retryWrites=true&w=majority"
        client = motor.motor_asyncio.AsyncIOMotorClient(
            url, uuidRepresentation="standard"
        )
        return client[db_name]


class TestDBStrategy(ConnectionStrategy):
    """
    Connect to a test DB for unit testing and add some test users.
    """

    def __init__(self):
        self.user = None

    def connect(self):
        client = AsyncMongoMockClient()
        return client.get_database("test")

    async def init_db(self):
        # Add test users
        from backend.auth.auth import UserManager

        user = UserCreate(
            id=1, email="john@foo.com", password="foo", is_active=True, is_verified=True
        )
        manager = UserManager(BeanieUserDatabase(User, OAuthAccount))
        self.user = await manager.create(user)

    def get_test_user(self):
        assert self.user, "init_db() must be called first"
        return self.user


class DBStoreAlreadyInitialized(Exception):
    pass


class DBStore(object):
    """
    A simple in-memory database for storing users.

    This is a singleton class, so there can only be one instance of it.

    This class is responsible for translating back and forth between documents
    using the MongoDB schema and the JSON data we return to HTTP clients. For
    example, we add the user ID to all documents along with the version of the
    document schema, and we don't want to leak these details when returning
    results in get_results(). See sanitize_results() for more info.
    """

    _instance = None

    # A list of keys that we don't want to return to the client but that are a
    # necessary part of the document schema.
    _internal_keys = ("_id", "user_id", "version", "test_name")

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(DBStore, cls).__new__(cls)
        return cls._instance

    def __init__(self):
        self.strategy = None
        self.started = False

    def setup(self, connection_strategy: ConnectionStrategy):
        if self.strategy:
            raise DBStoreAlreadyInitialized()

        self.strategy = connection_strategy
        self.db = self.strategy.connect()

    async def startup(self):
        if self.started:
            raise DBStoreAlreadyInitialized()

        await init_beanie(database=self.db, document_models=[User])
        await self.strategy.init_db()
        self.started = True

    async def add_results(self, user: User, test_name: str, results: List[Dict]):
        """
        Create the representation of test results for storing in the DB, e.g. add
        metadata like user id and version of the schema.
        """
        new_list = []
        for result in results:
            # TODO(matt) Fix this
            d = dict(result)
            d.update({"user_id": user.id, "test_name": test_name})
            new_list.append(d)

        test_results = self.db.test_results
        await test_results.insert_many(new_list)

    async def get_results(self, user: User, test_name: str) -> List[Dict]:
        """
        Retrieve test results for a given user and test name.

        If no results are found, return an empty list.
        """
        test_results = self.db.test_results

        # Strip out the internal keys
        exclude_projection = {key: 0 for key in self._internal_keys}

        results = await test_results.find(
            {"user_id": user.id, "test_name": test_name}, exclude_projection
        ).to_list()

        return results

    async def get_test_names(self, user: User) -> List[str]:
        """
        Get a list of all test names for a given user.

        Returns an empty list if no results are found.
        """
        test_results = self.db.test_results
        return await test_results.distinct("test_name", {"user_id": user.id})

    async def delete_all_results(self, user: User):
        """
        Delete all results for a given user.

        If no results are found, do nothing.
        """
        test_results = self.db.test_results
        await test_results.delete_many({"user_id": user.id})


# Will be patched by conftest.py if we're running tests
_TESTING = False


async def do_on_startup():
    store = DBStore()
    strategy = TestDBStrategy() if _TESTING else MongoDBStrategy()
    store.setup(strategy)
    await store.startup()
